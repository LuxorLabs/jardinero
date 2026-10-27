#!/bin/bash

# Commits the working tree changes to a new branch through the GitHub GraphQL API.
#
# The default branch ruleset requires signed commits. A plain `git commit` from a
# runner is unsigned, while a commit created through the API with a GitHub App
# token is signed by GitHub and shows as verified.
#
# Usage: commit_via_api.sh <branch> <commit message> [pathspec...]
# Commits only the given pathspecs; defaults to the whole working tree.
# Requires GH_TOKEN, a GitHub App installation token, and GITHUB_REPOSITORY.
# TARGET_REPOSITORY, when set, commits to that repo instead; Actions does not let
# a step override GITHUB_REPOSITORY.

set -euo pipefail

readonly BRANCH="$1"
readonly MESSAGE="$2"
readonly REPO="${TARGET_REPOSITORY:-$GITHUB_REPOSITORY}"
shift 2

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

head_sha=$(git rev-parse HEAD)
git add -A -- "${@:-.}"

if git diff --cached --quiet; then
    echo "Nothing to commit for $BRANCH" >&2
    exit 1
fi

# One {path, contents} object per added or modified file; contents are read from
# files because a large CHANGELOG.md would exceed the per-argument size limit
echo '[]' > "$work_dir/additions.json"
git diff --cached --no-renames --name-only --diff-filter=d -z | while IFS= read -r -d '' path; do
    base64 -w0 "$path" > "$work_dir/contents"
    jq --arg path "$path" --rawfile contents "$work_dir/contents" \
        '. + [{path: $path, contents: $contents}]' \
        "$work_dir/additions.json" > "$work_dir/additions.next.json"
    mv "$work_dir/additions.next.json" "$work_dir/additions.json"
done

git diff --cached --no-renames --name-only --diff-filter=D -z \
    | jq -R -s 'split("\u0000") | map(select(length > 0)) | map({path: .})' \
    > "$work_dir/deletions.json"

jq -n \
    --arg repo "$REPO" \
    --arg branch "$BRANCH" \
    --arg message "$MESSAGE" \
    --arg head_sha "$head_sha" \
    --slurpfile additions "$work_dir/additions.json" \
    --slurpfile deletions "$work_dir/deletions.json" \
    '{
        query: "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid url } } }",
        variables: {
            input: {
                branch: {repositoryNameWithOwner: $repo, branchName: $branch},
                # The first line is the headline, anything after it the body
                message: ($message | split("\n") | {headline: .[0], body: (.[1:] | join("\n") | ltrimstr("\n"))}),
                expectedHeadOid: $head_sha,
                fileChanges: {additions: $additions[0], deletions: $deletions[0]}
            }
        }
    }' > "$work_dir/request.json"

# Never reuse an existing branch: it may still back an open release PR
if gh api "repos/$REPO/git/ref/heads/$BRANCH" > /dev/null 2>&1; then
    echo "Branch $BRANCH already exists; close its PR and delete it before retrying" >&2
    exit 1
fi

echo "Creating branch $BRANCH at $head_sha"
gh api "repos/$REPO/git/refs" -f ref="refs/heads/$BRANCH" -f sha="$head_sha" > /dev/null

# The branch was created above and holds no commit yet, so drop it if the commit
# fails rather than leave it to block the next run
if ! gh api graphql --input "$work_dir/request.json" --jq '.data.createCommitOnBranch.commit | "Created commit \(.oid): \(.url)"'; then
    echo "Commit failed; deleting branch $BRANCH" >&2
    gh api -X DELETE "repos/$REPO/git/refs/heads/$BRANCH"
    exit 1
fi
