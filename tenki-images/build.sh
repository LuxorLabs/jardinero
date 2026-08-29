#!/usr/bin/env bash
# Build and publish a Tenki worker image for a repo's agent workflows.
#
# The build runs IN Tenki, not locally: this script only orchestrates the CLI.
# Flow: create a sandbox on the stock Tenki base -> run the composed setup
# (lib/base-setup.sh + recipes/<repo>.sh) inside it -> snapshot -> optionally
# canary-verify the snapshot (recipes/<repo>.verify.sh) -> publish -> clean up.
# Verification runs in a fresh sandbox spawned FROM the snapshot, so the
# published image stays clean (no repo clone or build artifacts baked in) yet
# is proven to build the repo. Publish only happens if the canary passes.
#
# Usage:
#   tenki-images/build.sh <repo> [--tag <tag>] [--base-image <ref>] [--dry-run] [--no-verify] [--keep]
#
# --base-image <ref> builds on an existing registry image; the new image inherits
# that base's kernel and clocksource.
#
# Env:
#   TENKI_API_KEY         required
#   TENKI_WORKSPACE_SLUG  optional   -> registry prefix; derived from the session
#   RECIPES_DIR           optional   -> where the recipes live (default: recipes/)
#   CODEX_VERSION         optional   -> Codex CLI to bake (default: latest).
#                                        Pin to the version that ships GPT-5.6.
#   GH_TOKEN / GITHUB_TOKEN  needed for canary clone of a private repo;
#                            falls back to `gh auth token`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "build.sh: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

# --- args ---------------------------------------------------------------
repo=""; channel="prod"; with_date=1; dry_run=""; keep=""; no_verify=""; reuse_snap=""; base_image=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) channel="$2"; shift 2 ;;
    --tag=*) channel="${1#*=}"; shift ;;
    --base-image) base_image="$2"; shift 2 ;;
    --base-image=*) base_image="${1#*=}"; shift ;;
    --from-snapshot) reuse_snap="$2"; shift 2 ;;
    --from-snapshot=*) reuse_snap="${1#*=}"; shift ;;
    --no-date) with_date=""; shift ;;
    --dry-run) dry_run=1; shift ;;
    --no-verify) no_verify=1; shift ;;
    --keep) keep=1; shift ;;
    -*) die "unknown flag: $1" ;;
    *) [ -z "$repo" ] || die "unexpected arg: $1"; repo="$1"; shift ;;
  esac
done
[ -n "$repo" ] || die "usage: tenki-images/build.sh <repo> [--tag <tag>] [--base-image <ref>] [--from-snapshot <id>] [--dry-run] [--no-verify] [--keep]"

# These values are interpolated into the composed sandbox script, so reject
# anything outside a safe slug charset to close host-side shell injection.
case "$repo" in *[!a-zA-Z0-9._-]*) die "invalid repo name: $repo" ;; esac
case "$channel" in *[!a-zA-Z0-9._-]*) die "invalid --tag value: $channel" ;; esac

recipes_dir="${RECIPES_DIR:-$here/recipes}"
recipe="$recipes_dir/$repo.sh"
env_file="$recipes_dir/$repo.env"
verify_script="$recipes_dir/$repo.verify.sh"
[ -f "$recipe" ] || die "no recipe for '$repo' (expected $recipe)"

# --- per-repo build metadata (host side) --------------------------------
IMAGE_NAME="$repo"
# REPO_SLUG has no sensible default; the recipe's .env names the repository the
# canary clones.
REPO_SLUG=""
SANDBOX_CPU=4
SANDBOX_MEMORY_MB=8192
SANDBOX_DISK_GB=30
# shellcheck source=/dev/null
[ -f "$env_file" ] && . "$env_file"

# The --base-image flag wins over a recipe's BASE_IMAGE default.
base_image="${base_image:-${BASE_IMAGE:-}}"
case "${base_image:-}" in *[!a-zA-Z0-9._:/@-]*) die "invalid base image ref: $base_image" ;; esac

CODEX_VERSION="${CODEX_VERSION:-latest}"
case "$IMAGE_NAME" in *[!a-zA-Z0-9._-]*|"") die "invalid IMAGE_NAME: $IMAGE_NAME" ;; esac
case "$CODEX_VERSION" in *[!a-zA-Z0-9._-]*) die "invalid CODEX_VERSION: $CODEX_VERSION" ;; esac

# Default to an immutable dated tag (e.g. prod-20260714-185030) so every image
# is a clear, traceable artifact; --no-date collapses it to the bare channel.
tag="$channel"
[ -n "$with_date" ] && tag="$channel-$(date -u +%Y%m%d-%H%M%S)"

# --- compose the in-sandbox setup script --------------------------------
# The preamble owns the shared shell scaffolding (strict mode, the as_root
# helper, the baked Codex version) so base-setup.sh and the recipe stay pure
# install steps.
composed="$(mktemp)"
trap 'rm -f "$composed"' EXIT
{
  cat <<PREAMBLE
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export CODEX_VERSION="$CODEX_VERSION"
as_root() {
  if [ "\$(id -u)" -eq 0 ]; then "\$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "\$@"
  else echo "setup requires root or passwordless sudo for: \$*" >&2; exit 1; fi
}
# Append "tool=version" lines to the image manifest. Base and each recipe call
# this with their own tools, so the tool list lives where the tools are installed.
record_versions() {
  for probe in "\$@"; do
    tool="\${probe%% *}"
    command -v "\$tool" >/dev/null 2>&1 || continue
    printf '%s=%s\n' "\$tool" "\$(\$probe 2>&1 | head -1)" | as_root tee -a /etc/jardinero-worker-versions >/dev/null
  done
}
: | as_root tee /etc/jardinero-worker-versions >/dev/null
printf 'image=%s\n' "$IMAGE_NAME:$tag" | as_root tee -a /etc/jardinero-worker-versions >/dev/null
PREAMBLE
  echo "# ===== lib/base-setup.sh ====="
  cat "$here/lib/base-setup.sh"
  echo "# ===== recipes/$repo.sh ====="
  cat "$recipe"
  echo 'echo "--- baked toolchain versions ---"; cat /etc/jardinero-worker-versions'
} > "$composed"

verify_enabled=""
[ -z "$no_verify" ] && [ -f "$verify_script" ] && verify_enabled=1

if [ -n "$dry_run" ]; then
  echo "# repo=$repo image=$IMAGE_NAME:$tag base=${base_image:-stock} codex=$CODEX_VERSION cpu=$SANDBOX_CPU mem=${SANDBOX_MEMORY_MB}MB disk=${SANDBOX_DISK_GB}GB verify=${verify_enabled:-0}"
  cat "$composed"
  [ -n "$verify_enabled" ] && { echo "# ===== canary: recipes/$repo.verify.sh (in $REPO_SLUG) ====="; cat "$verify_script"; }
  exit 0
fi

need tenki
need jq
[ -n "${TENKI_API_KEY:-}" ] || die "TENKI_API_KEY is required"

# Resolve a GitHub token only when we actually need to clone for the canary.
gh_token=""
if [ -n "$verify_enabled" ]; then
  [ -n "$REPO_SLUG" ] || die "canary needs REPO_SLUG=<owner>/<repo> in recipes/$repo.env (or pass --no-verify)"
  gh_token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  [ -z "$gh_token" ] && command -v gh >/dev/null 2>&1 && gh_token="$(gh auth token 2>/dev/null || true)"
  [ -n "$gh_token" ] || die "canary needs a GitHub token to clone $REPO_SLUG; set GH_TOKEN or run 'gh auth login' (or pass --no-verify)"
fi

# The image ref needs this workspace's registry namespace (its slug). Only registry
# entries carry it; the label filter excludes the images other workspaces share into
# the listing.
if [ -z "${TENKI_WORKSPACE_SLUG:-}" ]; then
  TENKI_WORKSPACE_SLUG="$(tenki sandbox registry list --output json 2>/dev/null \
    | jq -r '[.images[]? | select((.labels? // []) | index("app:jardinero")) | .workspace_slug] | .[0] // empty')"
fi
[ -n "${TENKI_WORKSPACE_SLUG:-}" ] || die "could not resolve the workspace slug; set TENKI_WORKSPACE_SLUG in the env"
image_ref="$TENKI_WORKSPACE_SLUG/$IMAGE_NAME:$tag"

# Terminate sandboxes we create (unless --keep) and reclaim a snapshot this run
# created but never published; a reused --from-snapshot one is never ours.
sandboxes=(); snapshot_created=0
# Unique per run so concurrent builds of the same repo don't collide on names.
run_suffix="$(date +%s)-$$"
cleanup() {
  rm -f "$composed" "${canary:-}"
  [ "${snapshot_created:-0}" -eq 1 ] && [ -n "${snap:-}" ] && \
    tenki sandbox snapshot delete "$snap" >/dev/null 2>&1 || true
  [ -n "$keep" ] && return 0
  for s in "${sandboxes[@]:-}"; do [ -n "$s" ] && tenki sandbox terminate "$s" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

create_sandbox() { # $1=name  [extra tenki-create args...] -> prints id
  local name="$1"; shift
  local out id orphan
  out="$(tenki sandbox create --name "$name" \
    --cpu "$SANDBOX_CPU" --memory-mb "$SANDBOX_MEMORY_MB" --disk-size-gb "$SANDBOX_DISK_GB" \
    --sticky "$@" --output json 2>/dev/null)" || true
  id="$(printf '%s' "$out" | jq -r '.id // .sandbox.id // empty')"
  if [ -n "$id" ]; then
    printf '%s\n' "$id"
  else
    # An unparseable id with a --sticky sandbox means a billing leak unless it
    # is reclaimed by its unique name.
    orphan="$(tenki sandbox list --output json 2>/dev/null \
      | jq -r --arg n "$name" '[.. | objects | select(.name?==$n)] | .[0].id // empty')"
    [ -n "$orphan" ] && tenki sandbox terminate "$orphan" >/dev/null 2>&1 || true
  fi
}

# `tenki sandbox exec` exits 0 even when the remote command fails, so the real
# status is smuggled out in a sentinel line and returned to the caller.
exec_checked() { # $1=session $2=remote-script-path
  local log rc=1; log="$(mktemp)"
  trap 'rm -f "$log"' RETURN  # fires on any exit path so the temp log never leaks
  tenki sandbox exec --session "$1" --stream -- bash -lc "bash '$2'; echo __RC=\$?__" 2>&1 | tee "$log"
  grep -q '__RC=0__' "$log" && rc=0
  return "$rc"
}

# --- build (skipped when reusing an existing snapshot) ------------------
if [ -n "$reuse_snap" ]; then
  snap="$reuse_snap"
  echo ">> reusing snapshot $snap (skipping build)"
else
  echo ">> creating build sandbox ($SANDBOX_CPU cpu / ${SANDBOX_MEMORY_MB}MB / ${SANDBOX_DISK_GB}GB${base_image:+ on $base_image})"
  if [ -n "$base_image" ]; then
    sid="$(create_sandbox "build-$IMAGE_NAME-$run_suffix" --image "$base_image")"
  else
    sid="$(create_sandbox "build-$IMAGE_NAME-$run_suffix")"
  fi
  [ -n "$sid" ] || die "could not parse sandbox id from create output"
  sandboxes+=("$sid")
  echo ">> sandbox $sid"

  echo ">> installing toolchain (base + $repo recipe)"
  tenki sandbox write --session "$sid" --path /home/tenki/setup.sh --data-file "$composed" >/dev/null
  exec_checked "$sid" /home/tenki/setup.sh || die "toolchain setup failed for $repo"

  echo ">> snapshotting"
  snap="$(tenki sandbox snapshot create "$sid" --wait-durable --output json | jq -r '.id // .snapshot.id // empty')"
  [ -n "$snap" ] || die "could not parse snapshot id"
  snapshot_created=1
  echo ">> snapshot $snap"
fi

# --- canary: verify the image can build the repo before publishing ------
if [ -n "$verify_enabled" ]; then
  echo ">> canary: verifying $REPO_SLUG builds in the new image"
  # The token goes in as session env, never baked into the script; the quoted
  # heredoc keeps $GH_TOKEN/$REPO_SLUG unexpanded until they run in the sandbox.
  canary="$(mktemp)"
  {
    cat <<'PRE'
#!/usr/bin/env bash
set -euo pipefail
# Session env from --env lives in /etc/environment, which exec shells don't
# load; source it so GH_TOKEN and REPO_SLUG are visible.
set -a; [ -r /etc/environment ] && . /etc/environment; set +a
git clone --depth 1 "https://x-access-token:${GH_TOKEN}@github.com/${REPO_SLUG}.git" "$HOME/canary-repo"
cd "$HOME/canary-repo"
PRE
    cat "$verify_script"
  } > "$canary"
  csid="$(create_sandbox "canary-$IMAGE_NAME-$run_suffix" --snapshot "$snap" --env "GH_TOKEN=$gh_token" --env "REPO_SLUG=$REPO_SLUG")"
  [ -n "$csid" ] || die "could not create canary sandbox"
  sandboxes+=("$csid")
  tenki sandbox write --session "$csid" --path /home/tenki/canary.sh --data-file "$canary" >/dev/null
  exec_checked "$csid" /home/tenki/canary.sh || die "canary failed for $repo; NOT publishing $image_ref"
  echo ">> canary passed"
fi

# --- publish -------------------------------------------------------------
echo ">> publishing $image_ref (private)"
tenki sandbox registry publish \
  --from-snapshot "$snap" \
  --image "$image_ref" \
  --visibility private \
  --label capsule --label app:jardinero \
  --title "Jardinero worker: $IMAGE_NAME" >/dev/null
snapshot_created=0

echo ""
echo "published: $image_ref"
if [ -n "$REPO_SLUG" ]; then
  echo "set this as worker.repos.\"$REPO_SLUG\".image in your config."
else
  echo "set this as worker.default.image in your config."
fi
