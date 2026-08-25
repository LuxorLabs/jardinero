import { computeAgentBranch, runIdShort } from './agent-branch.js';
import {
  extractGitHubPullRequestUrls,
  formatGitHubPullRequestUrl,
  parseGitHubPullRequestUrl,
  sameGitHubRepo,
} from '../platform/github-url.js';
import { isPlainObject, objectValue, stringValue } from '../platform/json.js';
import type { WorkerResult } from '../types.js';
import type { SandboxTask } from '../orchestrator/sandbox-pool.js';
import { numberPayload } from '../orchestrator/task-payload.js';

export {
  extractGitHubPullRequestUrl,
  extractGitHubPullRequestUrls,
  parseGitHubPullRequestUrl,
} from '../platform/github-url.js';

// isImplementationRun answers whether a pull request is the contract of the run, which
// is what makes verification gate hard on the branch and the trailer.
export function isImplementationRun(task: SandboxTask): boolean {
  if (task.workflow === 'fix_implement') return true;
  return task.workflow === 'linear' && stringPayload(task, 'role') !== 'verify';
}

export interface SideEffectCheck {
  name: string;
  status: 'verified' | 'warning' | 'failed' | 'skipped';
  detail: string;
}

export interface SideEffectVerification {
  status: 'verified' | 'warning' | 'failed' | 'skipped';
  checks: SideEffectCheck[];
  openedPrUrl?: string;
  openedPrBranch?: string;
}

export interface VerifySideEffectsOptions {
  runId: string;
  task: SandboxTask;
  result: unknown;
  workerResult?: Pick<WorkerResult, 'openedPrUrl' | 'noPrOutcome'>;
  githubToken?: string;
  fetchImpl?: typeof fetch;
}

interface GitHubPullRequest {
  state?: string;
  html_url?: string;
  head?: {
    ref?: string;
    sha?: string;
  };
}

interface GitHubCommit {
  commit?: {
    message?: string;
  };
}

export async function verifySideEffects(
  options: VerifySideEffectsOptions,
): Promise<SideEffectVerification> {
  const checks: SideEffectCheck[] = [];
  const repo = stringPayload(options.task, 'repo');
  const implementationRun = isImplementationRun(options.task);

  // A worker-declared no-PR outcome is authoritative; a predecessor PR referenced
  // in the output must not re-trigger branch/trailer gating for this run.
  if (implementationRun && options.workerResult?.noPrOutcome && !options.workerResult.openedPrUrl) {
    checks.push({
      name: 'no_pr_outcome',
      status: 'skipped',
      detail: `${options.workerResult.noPrOutcome.reason}: ${
        options.workerResult.noPrOutcome.recommendedFollowup ?? 'No PR warranted after validation.'
      }`,
    });
    return summarize(checks);
  }

  const openedPrUrl = extractOpenedPullRequestUrl(
    options.task,
    options.result,
    options.workerResult,
  );
  if (!openedPrUrl) {
    checks.push({
      name: 'opened_pr_url',
      status: implementationRun ? 'failed' : 'skipped',
      detail: implementationRun
        ? 'Implementation run did not report a GitHub pull request URL.'
        : 'No GitHub pull request URL found in worker result.',
    });
    return summarize(checks);
  }

  const parsed = parseGitHubPullRequestUrl(openedPrUrl);
  if (!parsed) {
    checks.push({
      name: 'opened_pr_url',
      status: 'failed',
      detail: `Could not parse pull request URL: ${openedPrUrl}`,
    });
    return summarize(checks, openedPrUrl);
  }

  if (options.task.workflow === 'log_review') {
    return verifyLogReviewPrMention(options, parsed.repo, parsed.number, openedPrUrl, checks);
  }

  const repoMismatch = repo !== undefined && !sameGitHubRepo(parsed.repo, repo);
  checks.push({
    name: 'opened_pr_url',
    status: repoMismatch ? 'failed' : 'verified',
    detail: openedPrUrl,
  });

  if (repoMismatch) {
    checks.push({
      name: 'repo_scope',
      status: 'failed',
      detail: `Expected ${repo}, got ${parsed.repo}`,
    });
    return summarize(checks, openedPrUrl);
  }

  if (!options.githubToken) {
    checks.push({
      name: 'github_api',
      status: 'warning',
      detail: 'GitHub token unavailable; skipped GitHub API verification.',
    });
    return summarize(checks, openedPrUrl);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let pr: GitHubPullRequest;
  try {
    pr = await githubJson<GitHubPullRequest>(
      fetchImpl,
      options.githubToken,
      `https://api.github.com/repos/${parsed.repo}/pulls/${parsed.number}`,
    );
  } catch (error) {
    checks.push({
      name: 'github_api',
      status: 'warning',
      detail: `Skipped GitHub PR verification: ${error instanceof Error ? error.message : String(error)}`,
    });
    return summarize(checks, openedPrUrl);
  }
  checks.push({
    name: 'github_pr_exists',
    status: pr.state ? 'verified' : 'failed',
    detail: pr.state ? `PR is ${pr.state}` : 'GitHub PR response did not include a state.',
  });

  const prHead = objectValue(pr.head);
  const branch = stringValue(prHead?.ref);
  // A pass told to continue a pull request is judged by that pull request: whatever the
  // head branch is called, it is the one the pass that opened it created.
  const continuedPullRequest = implementationRun
    ? numberPayload(options.task, 'pr_number')
    : undefined;
  if (continuedPullRequest !== undefined) {
    checks.push({
      name: 'continued_pull_request',
      status: parsed.number === continuedPullRequest ? 'verified' : 'failed',
      detail: `expected #${continuedPullRequest}, got #${parsed.number} (head.ref=${branch ?? 'unknown'})`,
    });
  }

  // Tolerant identification: any `agent/*` branch containing the runIdShort belongs to
  // this run. Codex sometimes paraphrases the prompt-instructed branch name, and
  // anchoring on the runIdShort keeps PR maintenance firing on those pull requests
  // instead of dropping them because the name did not match exactly.
  const branchIdentifiesRun =
    implementationRun &&
    (continuedPullRequest !== undefined || isAgentBranchForRun(branch, options.runId));
  if (implementationRun && continuedPullRequest === undefined) {
    const expectedBranch = computeAgentBranch(
      options.runId,
      stringPayload(options.task, 'fingerprint'),
    );
    checks.push({
      name: 'agent_branch',
      status: branchIdentifiesRun ? 'verified' : 'failed',
      detail: branch
        ? `head.ref=${branch}; expected=${expectedBranch}`
        : `PR head ref unavailable; expected=${expectedBranch}`,
    });
    // Soft signal: Codex deviated from the exact prompt-instructed shape.
    // Reported as a warning rather than a gate so we get visibility on how
    // often this happens without breaking the run.
    if (branchIdentifiesRun && branch !== expectedBranch) {
      checks.push({
        name: 'agent_branch_exact_shape',
        status: 'warning',
        detail: `Codex deviated from the prompt-instructed branch shape; head.ref=${branch}, expected=${expectedBranch}`,
      });
    }
  } else if (branch) {
    checks.push({
      name: 'head_branch',
      status: 'verified',
      detail: `head.ref=${branch}`,
    });
  }

  const sha = stringValue(prHead?.sha);
  if (!sha) {
    checks.push({
      name: 'agent_commit_trailer',
      status: 'warning',
      detail: 'PR head SHA unavailable; skipped commit trailer check.',
    });
    return summarize(checks, openedPrUrl, branch);
  }

  let commit: GitHubCommit;
  try {
    commit = await githubJson<GitHubCommit>(
      fetchImpl,
      options.githubToken,
      `https://api.github.com/repos/${parsed.repo}/commits/${sha}`,
    );
  } catch (error) {
    checks.push({
      name: 'agent_commit_trailer',
      status: 'warning',
      detail: `Skipped commit trailer check: ${error instanceof Error ? error.message : String(error)}`,
    });
    return summarize(checks, openedPrUrl, branch);
  }
  const message = stringValue(objectValue(commit.commit)?.message) ?? '';
  const hasTrailer = message.includes(`Agent-Run-Id: ${options.runId}`);

  // A scanned PR carrying neither this run's agent branch nor its commit trailer was not
  // opened by this run; the agent only referenced it, e.g. investigated an existing PR.
  // Report no attributable PR rather than gating this run against a foreign PR.
  if (implementationRun && !branchIdentifiesRun && !hasTrailer) {
    return summarize([
      {
        name: 'opened_pr_url',
        status: 'failed',
        detail: `No pull request opened by this run; referenced ${openedPrUrl} (head.ref=${
          branch ?? 'unknown'
        }) does not identify this run.`,
      },
    ]);
  }

  checks.push({
    name: 'agent_commit_trailer',
    status: hasTrailer ? 'verified' : implementationRun ? 'failed' : 'warning',
    detail: hasTrailer
      ? 'Head commit includes Agent-Run-Id trailer.'
      : 'Head commit does not include this run trailer.',
  });

  return summarize(checks, openedPrUrl, branch);
}

export function extractOpenedPullRequestUrl(
  task: SandboxTask,
  result: unknown,
  workerResult?: Pick<WorkerResult, 'openedPrUrl'>,
): string | undefined {
  const expectedRepo = stringPayload(task, 'repo');
  if (workerResult?.openedPrUrl) {
    const parsed = parseGitHubPullRequestUrl(workerResult.openedPrUrl);
    if (!expectedRepo || (parsed && sameGitHubRepo(parsed.repo, expectedRepo))) {
      return normalizedPullRequestUrl(workerResult.openedPrUrl, expectedRepo);
    }
    const preferred = preferredPullRequestUrl(task, result, expectedRepo);
    return preferred ? normalizedPullRequestUrl(preferred, expectedRepo) : workerResult.openedPrUrl;
  }
  if (!workflowNeedsPrUrlScan(task)) return undefined;
  const continued = continuedPullRequestUrl(task, expectedRepo);
  if (continued) return continued;
  const preferred = preferredPullRequestUrl(task, result, expectedRepo);
  return preferred ? normalizedPullRequestUrl(preferred, expectedRepo) : undefined;
}

function continuedPullRequestUrl(
  task: SandboxTask,
  expectedRepo: string | undefined,
): string | undefined {
  if (!isImplementationRun(task) || !expectedRepo) return undefined;
  const pullRequest = numberPayload(task, 'pr_number');
  return pullRequest === undefined
    ? undefined
    : formatGitHubPullRequestUrl(expectedRepo, pullRequest);
}

function preferredPullRequestUrl(
  task: SandboxTask,
  result: unknown,
  expectedRepo?: string,
): string | undefined {
  const urls = extractGitHubPullRequestUrls(result);
  if (isImplementationRun(task) && expectedRepo) {
    const finalMessageMatch = finalMessagePullRequestUrls(result).find((url) =>
      sameGitHubRepo(parseGitHubPullRequestUrl(url)?.repo, expectedRepo),
    );
    if (finalMessageMatch) return finalMessageMatch;

    const matching = urls.filter((url) =>
      sameGitHubRepo(parseGitHubPullRequestUrl(url)?.repo, expectedRepo),
    );
    const latestMatching = matching.at(-1);
    if (latestMatching) return latestMatching;
  }
  return urls[0];
}

function finalMessagePullRequestUrls(result: unknown): string[] {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return [];
  const lastMessage = (result as Record<string, unknown>).lastMessage;
  return typeof lastMessage === 'string' ? extractGitHubPullRequestUrls(lastMessage) : [];
}

async function verifyLogReviewPrMention(
  options: VerifySideEffectsOptions,
  repo: string,
  prNumber: number,
  openedPrUrl: string,
  checks: SideEffectCheck[],
): Promise<SideEffectVerification> {
  if (!options.githubToken) {
    checks.push({
      name: 'github_api',
      status: 'warning',
      detail:
        'PR URL found in log-review output, but GitHub token unavailable; skipped ownership verification.',
    });
    return summarize(checks);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let pr: GitHubPullRequest;
  try {
    pr = await githubJson<GitHubPullRequest>(
      fetchImpl,
      options.githubToken,
      `https://api.github.com/repos/${repo}/pulls/${prNumber}`,
    );
  } catch (error) {
    checks.push({
      name: 'github_api',
      status: 'warning',
      detail: `PR URL found in log-review output, but GitHub PR verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return summarize(checks);
  }

  const prHead = objectValue(pr.head);
  const branch = stringValue(prHead?.ref);
  // Same tolerant identification as in the fix_implement path — a log-review
  // run that accidentally produced a PR is a violation regardless of whether
  // Codex used the exact instructed branch name.
  const branchMatchesRun = isAgentBranchForRun(branch, options.runId);
  if (branchMatchesRun) {
    checks.push({
      name: 'log_review_no_pr',
      status: 'failed',
      detail: `Log review output referenced a PR branch for this run: head.ref=${branch}`,
    });
    return summarize(checks, openedPrUrl, branch);
  }

  const sha = stringValue(prHead?.sha);
  if (!sha) {
    checks.push({
      name: 'mentioned_pr_url',
      status: 'skipped',
      detail: 'PR URL appeared in log-review output, but the PR head SHA was unavailable.',
    });
    return summarize(checks);
  }

  let commit: GitHubCommit;
  try {
    commit = await githubJson<GitHubCommit>(
      fetchImpl,
      options.githubToken,
      `https://api.github.com/repos/${repo}/commits/${sha}`,
    );
  } catch (error) {
    checks.push({
      name: 'agent_commit_trailer',
      status: 'warning',
      detail: `PR URL found in log-review output, but commit verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return summarize(checks);
  }

  const message = stringValue(objectValue(commit.commit)?.message) ?? '';
  if (message.includes(`Agent-Run-Id: ${options.runId}`)) {
    checks.push({
      name: 'log_review_no_pr',
      status: 'failed',
      detail: 'Log review output referenced a PR whose head commit includes this run trailer.',
    });
    return summarize(checks, openedPrUrl, branch);
  }

  checks.push({
    name: 'mentioned_pr_url',
    status: 'skipped',
    detail: 'PR URL appeared in log-review output but is not tied to this run.',
  });
  return summarize(checks);
}

async function githubJson<T>(fetchImpl: typeof fetch, token: string, url: string): Promise<T> {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${url} failed with HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`GitHub API ${url} returned invalid JSON`);
  }
  if (!isPlainObject(body)) {
    throw new Error(`GitHub API ${url} returned a non-object response`);
  }
  return body as T;
}

function summarize(
  checks: SideEffectCheck[],
  openedPrUrl?: string,
  openedPrBranch?: string,
): SideEffectVerification {
  const status = checks.some((check) => check.status === 'failed')
    ? 'failed'
    : checks.some((check) => check.status === 'warning')
      ? 'warning'
      : checks.some((check) => check.status === 'verified')
        ? 'verified'
        : 'skipped';
  return { status, checks, openedPrUrl, openedPrBranch };
}

/**
 * Returns true if `branch` looks like an agent branch belonging to this run.
 *
 * We anchor on the runIdShort (8 hex chars) rather than the exact branch name
 * the prompt instructed Codex to use, because Codex sometimes paraphrases the
 * slug part of the name (seen in the wild). The runIdShort still uniquely
 * identifies the run, so downstream workflows can correctly trace the PR.
 */
function isAgentBranchForRun(branch: string | undefined, runId: string): boolean {
  if (!branch) return false;
  return branch.startsWith('agent/') && branch.includes(runIdShort(runId));
}

function stringPayload(task: SandboxTask, key: string): string | undefined {
  const value = task.payload[key];
  return typeof value === 'string' ? value : undefined;
}

function workflowNeedsPrUrlScan(task: SandboxTask): boolean {
  return isImplementationRun(task) || task.workflow === 'log_review';
}

function normalizedPullRequestUrl(url: string, expectedRepo?: string): string {
  const parsed = parseGitHubPullRequestUrl(url);
  if (!parsed || !hasDecoratedPullRequestUrlParts(url)) return url;
  const repo =
    expectedRepo && sameGitHubRepo(parsed.repo, expectedRepo) ? expectedRepo : parsed.repo;
  return formatGitHubPullRequestUrl(repo, parsed.number);
}

function hasDecoratedPullRequestUrlParts(url: string): boolean {
  try {
    const parsed = new URL(url);
    return Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
  } catch {
    return false;
  }
}
