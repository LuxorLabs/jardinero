// The GitHub pull request calls Jardinero makes on its own behalf: read one, flip
// a verified draft to ready-for-review, list the open ones, and sign the agent's commits.
// Hand-rolled fetch in the post-#102 house style: callers treat failures as
// best-effort and audit them, so every parse problem throws with enough detail
// for the audit row to be actionable.

import { logger } from '../../platform/logger.js';

const log = logger.child('github-api');

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

// PullRequestState is what a pull request looks like from outside: whether it is
// still open, what is on its head, whether its checks are red, and whether a
// reviewer is still waiting for an answer.
export interface PullRequestState {
  state: 'open' | 'merged' | 'closed';
  headCommitSha: string;
  checksAreRed: boolean;
  hasUnresolvedReviewThreads: boolean;
}

export interface PullRequestHead {
  nodeId: string;
  draft: boolean;
  headRef: string;
}

interface GitHubPrRequestOptions {
  repo: string;
  pullRequestNumber: number;
  token: string;
  fetchImpl?: typeof fetch;
}

export async function getPullRequestHead(
  options: GitHubPrRequestOptions,
): Promise<PullRequestHead> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${GITHUB_API_BASE}/repos/${options.repo}/pulls/${options.pullRequestNumber}`,
    {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${options.token}`,
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  const text = await response.text();
  const ref = `${options.repo}#${options.pullRequestNumber}`;
  if (!response.ok) {
    throw new Error(
      `GitHub PR lookup for ${ref} failed with HTTP ${response.status}: ${truncate(text)}`,
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text);
  } catch {
    throw new Error(`GitHub PR lookup for ${ref} returned invalid JSON`);
  }
  if (!isPlainObject(parsedBody)) {
    throw new Error(`GitHub PR lookup for ${ref} returned a non-object response`);
  }

  const nodeId = parsedBody.node_id;
  if (typeof nodeId !== 'string' || !nodeId) {
    throw new Error(`GitHub PR lookup for ${ref} returned no node id`);
  }
  const head = parsedBody.head;
  const headRef = isPlainObject(head) && typeof head.ref === 'string' ? head.ref.trim() : '';
  if (!headRef) {
    throw new Error(`GitHub PR lookup for ${ref} returned no head ref`);
  }

  return { nodeId, draft: parsedBody.draft === true, headRef };
}

// markPullRequestReadyForReview flips a draft. Idempotent: a pull request that is
// already non-draft is left untouched, since the mutation rejects it.
export async function markPullRequestReadyForReview(
  options: GitHubPrRequestOptions,
): Promise<void> {
  const head = await getPullRequestHead(options);
  if (!head.draft) return;

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query:
        'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
      variables: { id: head.nodeId },
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub mark-ready mutation failed with HTTP ${response.status}: ${truncate(text)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('GitHub mark-ready mutation returned invalid JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new Error('GitHub mark-ready mutation returned a non-object response');
  }
  const errors = parsed.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`GitHub mark-ready mutation errors: ${truncate(JSON.stringify(errors))}`);
  }
  if (!isPlainObject(parsed.data)) {
    throw new Error('GitHub mark-ready mutation response is missing data');
  }
}

// STATE_QUERY asks everything PullRequestState carries in one round trip.
const STATE_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      merged
      headRefOid
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      reviewThreads(first: 100) { nodes { isResolved isOutdated } }
    }
  }
}`;

export async function getPullRequestState(options: {
  repo: string;
  pullRequestNumber: number;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<PullRequestState> {
  const [owner, name] = options.repo.split('/');
  const ref = `${options.repo}#${options.pullRequestNumber}`;
  if (!owner || !name) throw new Error(`Invalid GitHub repository name: ${options.repo}`);

  const data = await githubGraphql(options, STATE_QUERY, {
    owner,
    name,
    number: options.pullRequestNumber,
  });
  const pullRequest = pathOf(data, ['repository', 'pullRequest']);
  if (!pullRequest) throw new Error(`GitHub PR state query for ${ref} returned no pull request`);
  const headCommitSha = pullRequest.headRefOid;
  if (typeof headCommitSha !== 'string' || !headCommitSha) {
    throw new Error(`GitHub PR state query for ${ref} returned no head sha`);
  }
  // Absent, both read as clear to act on, which is the answer that lets a pass through.
  const commit = pathOf(pullRequest, ['commits', 'nodes', '0', 'commit']);
  if (!commit || !isPlainObject(pullRequest.reviewThreads)) {
    log.error('github answered with a pull request we could only half read', {
      pull_request: ref,
      answer: truncate(JSON.stringify(pullRequest)),
    });
  }
  const rollup = pathOf(commit, ['statusCheckRollup']);
  const threads = nodesAt(pullRequest, ['reviewThreads', 'nodes']);
  return {
    state:
      pullRequest.merged === true ? 'merged' : pullRequest.state === 'CLOSED' ? 'closed' : 'open',
    headCommitSha,
    checksAreRed: rollup?.state === 'FAILURE',
    // An outdated thread is about code that is no longer there, so it is not
    // something an agent can act on.
    hasUnresolvedReviewThreads: threads.some(
      (thread) => thread.isResolved === false && thread.isOutdated === false,
    ),
  };
}

export interface OpenPullRequest {
  pullRequestNumber: number;
  headBranch?: string;
  isDraft: boolean;
  title?: string;
  body?: string;
}

// listOpenPullRequests answers every open pull request of a repository; which of them are
// ours is decided by PrMaintainer.
export async function listOpenPullRequests(options: {
  repo: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<OpenPullRequest[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pageSize = 100;
  const maxPages = 10;
  const found: OpenPullRequest[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await fetchImpl(
      `${GITHUB_API_BASE}/repos/${options.repo}/pulls?state=open&per_page=${pageSize}&page=${page}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${options.token}`,
          'x-github-api-version': '2022-11-28',
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub list PRs for ${options.repo} failed with HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`GitHub list PRs for ${options.repo} returned invalid JSON`);
    }
    if (!Array.isArray(body)) {
      throw new Error(`GitHub list PRs for ${options.repo} returned a non-array response`);
    }

    for (const item of body) {
      const number = isPlainObject(item) ? item.number : undefined;
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
        // A pull request we cannot read is one the sweep will not maintain.
        log.error('github listed a pull request we could not read', {
          repo: options.repo,
          answer: truncate(JSON.stringify(item)),
        });
        continue;
      }
      const head = isPlainObject(item.head) ? item.head : undefined;
      found.push({
        pullRequestNumber: number,
        headBranch: typeof head?.ref === 'string' ? head.ref : undefined,
        isDraft: item.draft === true,
        ...(typeof item.title === 'string' ? { title: item.title } : {}),
        ...(typeof item.body === 'string' ? { body: item.body } : {}),
      });
    }
    if (body.length < pageSize) break;
  }
  return found;
}

// CommitSigningOutcome is what signing a pull request did: nothing it had to do, the commits it
// re-created, or the commit it stopped at because it is not the agent's.
export type CommitSigningOutcome =
  | { status: 'not_required' }
  | { status: 'already_signed' }
  | { status: 'signed'; recreated: number; headSha: string }
  | { status: 'foreign_commit'; sha: string };

// CommitSigningRefusal is a failure to sign that trying again cannot change.
export class CommitSigningRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitSigningRefusal';
  }
}

// MAX_LISTED_COMMITS is where GitHub stops listing the commits of a pull request.
const MAX_LISTED_COMMITS = 250;

// SIGNING_HEAD_QUERY asks what moving the head needs and whether the base branch requires
// signed commits, either by a ruleset or by a classic branch protection rule.
const SIGNING_HEAD_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    id
    pullRequest(number: $number) {
      headRefName
      headRefOid
      isCrossRepository
      baseRef {
        refUpdateRule { requiresSignatures }
        rules(first: 100) { nodes { type } }
      }
    }
  }
}`;

// MOVE_HEAD_MUTATION moves the head branch only if it still points where the commits were
// read, so a push that lands meanwhile is never overwritten.
const MOVE_HEAD_MUTATION = `
mutation($repositoryId: ID!, $name: GitRefname!, $before: GitObjectID!, $after: GitObjectID!) {
  updateRefs(input: { repositoryId: $repositoryId, refUpdates: [{ name: $name, beforeOid: $before, afterOid: $after, force: true }] }) {
    clientMutationId
  }
}`;

// PullRequestCommit is what re-creating a listed commit needs from it.
interface PullRequestCommit {
  sha: string;
  parents: string[];
  message: string;
  tree: string;
  authorEmail: string;
  verified: boolean;
}

// signPullRequestCommits re-creates the unsigned commits of a pull request through the API, which
// GitHub signs for an App, and moves the head onto them, when the base branch requires signatures.
export async function signPullRequestCommits(options: {
  repo: string;
  pullRequestNumber: number;
  token: string;
  authorEmail: string;
  fetchImpl?: typeof fetch;
}): Promise<CommitSigningOutcome> {
  const [owner, name] = options.repo.split('/');
  const ref = `${options.repo}#${options.pullRequestNumber}`;
  if (!owner || !name)
    throw new CommitSigningRefusal(`Invalid GitHub repository name: ${options.repo}`);

  const data = await githubGraphql(options, SIGNING_HEAD_QUERY, {
    owner,
    name,
    number: options.pullRequestNumber,
  });
  const repositoryId = pathOf(data, ['repository'])?.id;
  const pullRequest = pathOf(data, ['repository', 'pullRequest']);
  const headRefName = pullRequest?.headRefName;
  const headRefOid = pullRequest?.headRefOid;
  if (
    typeof repositoryId !== 'string' ||
    typeof headRefName !== 'string' ||
    !headRefName ||
    typeof headRefOid !== 'string' ||
    !headRefOid
  ) {
    throw new Error(`GitHub PR head query for ${ref} returned no head branch`);
  }
  if (pullRequest?.isCrossRepository === true) {
    throw new CommitSigningRefusal(`The head branch of ${ref} lives in a fork`);
  }
  const requiresSignatures =
    pathOf(pullRequest, ['baseRef', 'refUpdateRule'])?.requiresSignatures === true ||
    nodesAt(pullRequest, ['baseRef', 'rules', 'nodes']).some(
      (rule) => rule.type === 'REQUIRED_SIGNATURES',
    );
  if (!requiresSignatures) return { status: 'not_required' };

  const commits = await listPullRequestCommits(options, ref);
  const ordered = ancestryOrder(commits, headRefOid);
  if (ordered.length === 0) throw new Error(`GitHub PR commits for ${ref} did not list its head`);
  // A commit whose parent is re-created must be re-created too, to point at the new parent, even
  // when it is already signed.
  const stale = new Set<string>();
  for (const commit of ordered) {
    if (!commit.verified || commit.parents.some((parent) => stale.has(parent))) {
      stale.add(commit.sha);
    }
  }
  if (stale.size === 0) return { status: 'already_signed' };
  const range = ordered.filter((commit) => stale.has(commit.sha));
  // Stop at anyone else's commit: re-creating it would make the App its author.
  const foreign = range.find(
    (commit) => commit.authorEmail.toLowerCase() !== options.authorEmail.toLowerCase(),
  );
  if (foreign) return { status: 'foreign_commit', sha: foreign.sha };

  const recreatedShas = new Map<string, string>();
  let headSha = '';
  for (const commit of range) {
    headSha = await createSignedCommit(options, ref, {
      message: commit.message,
      tree: commit.tree,
      parents: commit.parents.map((parent) => recreatedShas.get(parent) ?? parent),
    });
    recreatedShas.set(commit.sha, headSha);
  }

  await githubGraphql(options, MOVE_HEAD_MUTATION, {
    repositoryId,
    name: `refs/heads/${headRefName}`,
    before: headRefOid,
    after: headSha,
  });
  return { status: 'signed', recreated: range.length, headSha };
}

// ancestryOrder answers the listed commits the head reaches, every parent before its children;
// nothing when the head is not listed.
function ancestryOrder(commits: PullRequestCommit[], headSha: string): PullRequestCommit[] {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const ordered: PullRequestCommit[] = [];
  const visited = new Set<string>();
  const visit = (sha: string): void => {
    const commit = bySha.get(sha);
    if (!commit || visited.has(sha)) return;
    visited.add(sha);
    for (const parent of commit.parents) visit(parent);
    ordered.push(commit);
  };
  visit(headSha);
  return ordered;
}

async function listPullRequestCommits(
  options: { repo: string; pullRequestNumber: number; token: string; fetchImpl?: typeof fetch },
  ref: string,
): Promise<PullRequestCommit[]> {
  const pageSize = 100;
  const commits: PullRequestCommit[] = [];
  for (let page = 1; page <= Math.ceil(MAX_LISTED_COMMITS / pageSize); page += 1) {
    const body = await githubRest(
      options,
      'GET',
      `/repos/${options.repo}/pulls/${options.pullRequestNumber}/commits?per_page=${pageSize}&page=${page}`,
    );
    if (!Array.isArray(body)) {
      throw new Error(`GitHub PR commits for ${ref} returned a non-array response`);
    }
    for (const item of body) commits.push(pullRequestCommit(item, ref));
    if (body.length < pageSize) break;
  }
  // Refuse at the cap: GitHub stops listing there, so the head may be missing from the read.
  if (commits.length >= MAX_LISTED_COMMITS) {
    throw new CommitSigningRefusal(`${ref} has too many commits to read them all`);
  }
  return commits;
}

function pullRequestCommit(item: unknown, ref: string): PullRequestCommit {
  const sha = isPlainObject(item) ? item.sha : undefined;
  const commit = isPlainObject(item) ? item.commit : undefined;
  const parents = isPlainObject(item) && Array.isArray(item.parents) ? item.parents : undefined;
  const tree = pathOf(commit, ['tree'])?.sha;
  const authorEmail = pathOf(commit, ['author'])?.email;
  if (
    typeof sha !== 'string' ||
    !isPlainObject(commit) ||
    typeof commit.message !== 'string' ||
    typeof tree !== 'string' ||
    typeof authorEmail !== 'string' ||
    !parents?.every((parent) => isPlainObject(parent) && typeof parent.sha === 'string')
  ) {
    throw new Error(`GitHub PR commits for ${ref} listed a commit we could not read`);
  }
  return {
    sha,
    parents: parents.map((parent) => (parent as { sha: string }).sha),
    message: commit.message,
    tree,
    authorEmail,
    verified: pathOf(commit, ['verification'])?.verified === true,
  };
}

// createSignedCommit creates a commit and refuses it unless GitHub signed it, so the branch
// never moves onto an unsigned one.
async function createSignedCommit(
  options: { repo: string; token: string; fetchImpl?: typeof fetch },
  ref: string,
  commit: { message: string; tree: string; parents: string[] },
): Promise<string> {
  const body = await githubRest(options, 'POST', `/repos/${options.repo}/git/commits`, commit);
  const sha = isPlainObject(body) ? body.sha : undefined;
  if (typeof sha !== 'string' || !sha) {
    throw new Error(`GitHub commit creation for ${ref} returned no sha`);
  }
  if (pathOf(body, ['verification'])?.verified !== true) {
    throw new CommitSigningRefusal(`GitHub did not sign the commit re-created for ${ref}`);
  }
  return sha;
}

async function githubRest(
  options: { token: string; fetchImpl?: typeof fetch },
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${GITHUB_API_BASE}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${options.token}`,
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub ${method} ${path} failed with HTTP ${response.status}: ${truncate(text)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GitHub ${method} ${path} returned invalid JSON`);
  }
}

async function githubGraphql(
  options: { token: string; fetchImpl?: typeof fetch },
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json',
      accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed: ${response.status} ${truncate(text)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`GitHub GraphQL returned invalid JSON: ${truncate(text)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error('GitHub GraphQL returned a non-object response');
  }
  const errors = parsed.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`GitHub GraphQL errors: ${truncate(JSON.stringify(errors))}`);
  }
  if (!isPlainObject(parsed.data)) {
    throw new Error('GitHub GraphQL response is missing data');
  }
  return parsed.data;
}

function pathOf(value: unknown, keys: string[]): Record<string, unknown> | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (Array.isArray(current)) current = current[Number(key)];
    else if (isPlainObject(current)) current = current[key];
    else return undefined;
  }
  return isPlainObject(current) ? current : undefined;
}

// nodesAt walks to a GraphQL node list, which pathOf cannot answer because an array
// is not a plain object.
function nodesAt(value: unknown, keys: string[]): Record<string, unknown>[] {
  let current: unknown = value;
  for (const key of keys) {
    if (!isPlainObject(current)) return [];
    current = current[key];
  }
  return Array.isArray(current) ? current.filter(isPlainObject) : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}
