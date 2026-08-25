// handleGitHubDelivery reads one GitHub webhook delivery and turns it into the
// events of the machines that care. It decides nothing with what it reads: whether
// something is an event at all is decided inside each machine.

import type { AppConfig, LogReviewRepoConfig } from '../../config.js';
import type { LogReviewerStateEngineInterface } from '../../orchestrator/state-machines/log-reviewer/service.js';
import type { PrMaintainerStateEngineInterface } from '../../orchestrator/state-machines/pr-maintainer/service.js';
import { arrayValue, objectValue, stringValue } from '../../platform/json.js';
import type { Store } from '../../store/store.js';
import { AGENT_PR_COMMENT_MARKER } from '../../workflows/pr/pr-maintainer.js';

type JsonObject = Record<string, unknown>;

export interface GitHubDeliveryDeps {
  config: AppConfig;
  store: Store;
  prMaintainer: PrMaintainerStateEngineInterface;
  logReviewer: Pick<LogReviewerStateEngineInterface, 'onScheduledScan'>;
}

export interface GitHubDelivery {
  eventName: string;
  payload: JsonObject;
}

// GitHubDeliveryOutcome says whether the delivery reached a machine and, when it
// did not, why; a reason is what makes a discarded delivery visible.
export interface GitHubDeliveryOutcome {
  handled: boolean;
  reason?: string;
}

interface PullRequestRef {
  repositoryId: string;
  pullRequestNumber: number;
}

export async function handleGitHubDelivery(
  deps: GitHubDeliveryDeps,
  delivery: GitHubDelivery,
): Promise<GitHubDeliveryOutcome> {
  switch (delivery.eventName) {
    case 'pull_request':
      if (!deps.config.workflows.prMaintainer.enabled) {
        return { handled: false, reason: 'pr_maintain_disabled' };
      }
      return handlePullRequest(deps, delivery.payload);
    case 'pull_request_review':
    case 'pull_request_review_comment':
    case 'issue_comment':
      if (!deps.config.workflows.prMaintainer.enabled) {
        return { handled: false, reason: 'pr_maintain_disabled' };
      }
      return handleComment(deps, delivery.eventName, delivery.payload);
    case 'check_suite':
      if (!deps.config.workflows.prMaintainer.enabled) {
        return { handled: false, reason: 'pr_maintain_disabled' };
      }
      return handleCheckSuite(deps, delivery.payload);
    case 'deployment_status':
      if (!deps.config.workflows.logReviewer.enabled) {
        return { handled: false, reason: 'log_review_disabled' };
      }
      return handleDeploymentStatus(deps, delivery.payload);
    default:
      return { handled: false, reason: 'event_ignored' };
  }
}

async function handlePullRequest(
  deps: GitHubDeliveryDeps,
  payload: JsonObject,
): Promise<GitHubDeliveryOutcome> {
  const pullRequest = objectValue(payload.pull_request);
  if (!pullRequest) return { handled: false, reason: 'missing_pull_request' };
  const ref = refFor(deps, payload, numberOf(pullRequest.number));
  if (!ref) return { handled: false, reason: 'delivery_without_repository' };

  const facts = { ...ref, headBranch: headBranchOf(pullRequest) };

  switch (stringValue(payload.action)) {
    case 'ready_for_review':
      await deps.prMaintainer.onPrReadyForReview(facts);
      return { handled: true };
    case 'reopened':
      await deps.prMaintainer.onPrReopened(facts);
      return { handled: true };
    case 'synchronize':
      await deps.prMaintainer.onPrSynchronize(
        ref,
        stringValue(objectValue(pullRequest.head)?.sha) ?? '',
      );
      return { handled: true };
    case 'closed':
      if (pullRequest.merged === true) await deps.prMaintainer.onPrMerged(ref);
      else await deps.prMaintainer.onPrClosed(ref);
      return { handled: true };
    default:
      return { handled: false, reason: 'pull_request_action_ignored' };
  }
}

async function handleComment(
  deps: GitHubDeliveryDeps,
  eventName: string,
  payload: JsonObject,
): Promise<GitHubDeliveryOutcome> {
  const action = stringValue(payload.action);
  if (action === 'deleted') {
    return { handled: false, reason: 'comment_action_ignored' };
  }
  // A review is an ask when it is submitted; editing or dismissing an old one is
  // not, and treating it as one spends a pass on a comment nobody just wrote.
  if (eventName === 'pull_request_review' && action !== 'submitted') {
    return { handled: false, reason: 'review_action_ignored' };
  }
  // An issue comment is on a pull request only when the issue carries the
  // pull_request block; a plain issue is not ours.
  const issue = objectValue(payload.issue);
  const pullRequest =
    objectValue(payload.pull_request) ?? (objectValue(issue?.pull_request) ? issue : undefined);
  if (!pullRequest) return { handled: false, reason: 'not_a_pull_request' };
  const ref = refFor(deps, payload, numberOf(pullRequest.number));
  if (!ref) return { handled: false, reason: 'delivery_without_repository' };

  const comment = objectValue(payload.comment) ?? objectValue(payload.review);
  const body = stringValue(comment?.body);
  const author = stringValue(objectValue(comment?.user)?.login);
  const authoredByUs = isOurs(deps.config, author, body);
  await deps.prMaintainer.onPrComment({
    ...ref,
    authoredByUs,
    mentionsUs: mentionsUs(deps.config, body),
    isDraft: pullRequest.draft === true,
    isMerged: pullRequest.merged === true || stringValue(pullRequest.merged_at) !== undefined,
    reviewThreadId: reviewThreadIdOf(eventName, comment),
    comment: authoredByUs
      ? undefined
      : {
          author,
          body,
          externalId: commentExternalId(comment),
          commentType: commentTypeOf(eventName),
        },
  });
  return { handled: true, reason: eventName };
}

function headBranchOf(pullRequest: JsonObject): string | undefined {
  return stringValue(objectValue(pullRequest.head)?.ref);
}

// commentExternalId is where a reply goes: the comment id, when GitHub sent one.
function commentExternalId(comment: JsonObject | undefined): string | undefined {
  const id = numberOf(comment?.id);
  return id === undefined ? undefined : String(id);
}

// GitHub takes a reaction on an issue or a review comment, each under its own endpoint,
// and on a review body nowhere at all.
function commentTypeOf(eventName: string): 'issue' | 'review' | undefined {
  if (eventName === 'pull_request_review_comment') return 'review';
  return eventName === 'issue_comment' ? 'issue' : undefined;
}

// Threads exist only on review comments: a reply names the root comment it answers,
// and a root comment is itself the thread.
function reviewThreadIdOf(eventName: string, comment: JsonObject | undefined): string | undefined {
  if (eventName !== 'pull_request_review_comment') return undefined;
  const rootId = numberOf(comment?.in_reply_to_id) ?? numberOf(comment?.id);
  return rootId === undefined ? undefined : String(rootId);
}

// handleCheckSuite reports the outcome to every pull request the suite names; only
// the ones we follow have an instance to move.
async function handleCheckSuite(
  deps: GitHubDeliveryDeps,
  payload: JsonObject,
): Promise<GitHubDeliveryOutcome> {
  if (stringValue(payload.action) !== 'completed') {
    return { handled: false, reason: 'check_suite_action_ignored' };
  }
  const checkSuite = objectValue(payload.check_suite);
  if (!checkSuite) return { handled: false, reason: 'missing_check_suite' };
  const checksAreRed = stringValue(checkSuite.conclusion) === 'failure';

  let handled = false;
  for (const item of arrayValue(checkSuite.pull_requests)) {
    const ref = refFor(deps, payload, numberOf(objectValue(item)?.number));
    if (!ref) continue;
    await deps.prMaintainer.onPrCICompleted({ ...ref, checksAreRed });
    handled = true;
  }
  return handled ? { handled: true } : { handled: false, reason: 'check_suite_without_pr' };
}

// handleDeploymentStatus announces one scan per configured target of the deployed
// repository, because a deploy is when new errors show up in the logs.
async function handleDeploymentStatus(
  deps: GitHubDeliveryDeps,
  payload: JsonObject,
): Promise<GitHubDeliveryOutcome> {
  const deploymentStatus = objectValue(payload.deployment_status);
  if (!deploymentStatus) return { handled: false, reason: 'missing_deployment_status' };
  if (stringValue(deploymentStatus.state) !== 'success') {
    return { handled: false, reason: 'deployment_not_successful' };
  }

  const fullName = stringValue(objectValue(payload.repository)?.full_name);
  const targets = deps.config.workflows.logReviewer.repos.filter(
    (candidate) => candidate.repo === fullName,
  );
  if (targets.length === 0) return { handled: false, reason: 'repo_out_of_scope' };

  const environment =
    stringValue(objectValue(payload.deployment)?.environment) ??
    stringValue(deploymentStatus.environment);
  const repositoryId = deps.store.upsertRepository(fullName as string).id;

  let handled = false;
  for (const target of targets) {
    if (!coversEnvironment(target, environment)) continue;
    // The target key must be identical across callers, so several announcements of one
    // target converge on a single scan.
    await deps.logReviewer.onScheduledScan({
      repositoryId,
      serviceName: target.namespace,
      environmentName: target.namespace,
    });
    handled = true;
  }
  return handled ? { handled: true } : { handled: false, reason: 'environment_out_of_scope' };
}

// A target with no cluster of its own answers for every environment; one that names
// clusters only answers for those and for the environments we deploy to.
function coversEnvironment(target: LogReviewRepoConfig, environment: string | undefined): boolean {
  if (!environment) return true;
  const covered = ['staging', 'production', 'prod', ...target.clusters];
  return covered.includes(environment);
}

function refFor(
  deps: GitHubDeliveryDeps,
  payload: JsonObject,
  pullRequestNumber: number | undefined,
): PullRequestRef | undefined {
  if (pullRequestNumber === undefined) return undefined;
  const fullName = stringValue(objectValue(payload.repository)?.full_name);
  if (!fullName) return undefined;
  // The App installation decides which repositories reach us, so seeing one is
  // enough to register it.
  return { repositoryId: deps.store.upsertRepository(fullName).id, pullRequestNumber };
}

function isOurs(config: AppConfig, author: string | undefined, body: string | undefined): boolean {
  const agent = config.workflows.prMaintainer.agentLogin.toLowerCase();
  if (agent && author?.toLowerCase() === `${agent}[bot]`) return true;
  return body?.includes(AGENT_PR_COMMENT_MARKER) ?? false;
}

function mentionsUs(config: AppConfig, body: string | undefined): boolean {
  if (!body) return false;
  if (!config.workflows.prMaintainer.agentLogin) return false;
  const login = config.workflows.prMaintainer.agentLogin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9-])@${login}(?![a-z0-9-])`, 'i').test(body);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
