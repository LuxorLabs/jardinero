// Row shapes of every table in db/schema.sql, in schema order.

export type RequestSource = 'discord' | 'github' | 'linear' | 'cron' | 'operator';

export type RequestRouterState = 'rr_pending' | 'rr_routing' | 'rr_resolved' | 'rr_unresolvable';

export type SubjectType = 'linear_issue' | 'pull_request' | 'log_target';

export type ReplyTargetType = 'discord_thread' | 'github_comment' | 'linear_session';

export const REQUEST_ROUTER_TERMINAL_STATES: readonly RequestRouterState[] = [
  'rr_resolved',
  'rr_unresolvable',
];

export type LinearImplementerState =
  | 'li_pending'
  | 'li_implementing'
  | 'li_verifying'
  | 'li_needs_human'
  | 'li_waiting_pr'
  | 'li_done'
  | 'li_abandoned'
  | 'li_dismissed';

export const LINEAR_IMPLEMENTER_TERMINAL_STATES: readonly LinearImplementerState[] = [
  'li_done',
  'li_abandoned',
  'li_dismissed',
];

export type FixImplementerState =
  | 'fi_pending'
  | 'fi_implementing'
  | 'fi_verifying'
  | 'fi_needs_human'
  | 'fi_discarded'
  | 'fi_waiting_pr'
  | 'fi_done'
  | 'fi_abandoned'
  | 'fi_dismissed';

// Refusing a finding is a legitimate end, so fi_discarded is terminal.
export const FIX_IMPLEMENTER_TERMINAL_STATES: readonly FixImplementerState[] = [
  'fi_discarded',
  'fi_done',
  'fi_abandoned',
  'fi_dismissed',
];

export type LogReviewerState = 'lr_pending' | 'lr_working' | 'lr_done' | 'lr_failed';

export const LOG_REVIEWER_TERMINAL_STATES: readonly LogReviewerState[] = ['lr_done', 'lr_failed'];

export type VerifierVerdict = 'accept' | 'reject';

export type PrMaintainerState =
  | 'prm_pending'
  | 'prm_working'
  | 'prm_waiting'
  | 'prm_attempts_exhausted'
  | 'prm_merged'
  | 'prm_closed'
  | 'prm_dismissed';

export const PR_MAINTAINER_TERMINAL_STATES: readonly PrMaintainerState[] = [
  'prm_merged',
  'prm_closed',
  'prm_dismissed',
];

export type SandboxRunState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'aborted'
  | 'orphaned'
  | 'skipped';

// The five workflow tables a run or an event can belong to.
export const WORKFLOW_TYPES = [
  'request_router',
  'linear_implementer',
  'fix_implementer',
  'pr_maintainer',
  'log_reviewer',
] as const;

export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

export interface Repository {
  id: string;
  fullName: string;
  isEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RequestRouter {
  id: string;
  requestSource: RequestSource;
  workflowState: RequestRouterState;
  requestText: string | null;
  requesterExternalId: string | null;
  replyTargetType: ReplyTargetType | null;
  replyTargetId: string | null;
  repositoryId: string | null;
  subjectType: SubjectType | null;
  subjectExternalId: string | null;
  resolutionNote: string | null;
  workflowType: WorkflowType | null;
  workflowInstanceId: string | null;
  consumedAt: number | null;
  sandboxRunId: string | null;
  lastStateCheckedAt: number | null;
  stateChangedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface LinearImplementer {
  id: string;
  requestRouterId: string | null;
  workflowState: LinearImplementerState;
  repositoryId: string;
  linearIssueId: string;
  linearIssueIdentifier: string;
  linearSessionId: string | null;
  promptContext: string | null;
  pullRequestNumber: number | null;
  iterationNumber: number;
  verifiedCommitSha: string | null;
  verifierVerdict: VerifierVerdict | null;
  verifierIssues: string | null;
  sandboxRunId: string | null;
  needsHumanReason: string | null;
  lastStateCheckedAt: number | null;
  stateChangedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface FixImplementer {
  id: string;
  logReviewerId: string | null;
  workflowState: FixImplementerState;
  repositoryId: string;
  findingFingerprint: string;
  serviceName: string | null;
  environmentName: string | null;
  findingEvidence: string | null;
  pullRequestNumber: number | null;
  verifiedCommitSha: string | null;
  verifierVerdict: VerifierVerdict | null;
  verifierIssues: string | null;
  sandboxRunId: string | null;
  needsHumanReason: string | null;
  discardReason: string | null;
  lastStateCheckedAt: number | null;
  stateChangedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface LogReviewer {
  id: string;
  requestRouterId: string | null;
  workflowState: LogReviewerState;
  repositoryId: string;
  serviceName: string | null;
  environmentName: string | null;
  findingCount: number;
  sandboxRunId: string | null;
  lastStateCheckedAt: number | null;
  stateChangedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface PrMaintainer {
  id: string;
  requestRouterId: string | null;
  workflowState: PrMaintainerState;
  repositoryId: string;
  pullRequestNumber: number;
  attemptCount: number;
  lastActedCommitSha: string | null;
  sandboxRunId: string | null;
  needsHumanReason: string | null;
  lastStateCheckedAt: number | null;
  stateChangedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface PrMaintainerThread {
  id: string;
  prMaintainerId: string;
  reviewThreadId: string;
  replyCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface DiscordConversation {
  conversationKey: string;
  threadId: string;
  createdAt: number;
}

export interface SandboxRun {
  id: string;
  agentName: string;
  runState: SandboxRunState;
  workflowType: WorkflowType;
  workflowInstanceId: string;
  sandboxSessionId: string | null;
  costUsd: number | null;
  errorMessage: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface EventLogEntry {
  id: string;
  eventType: string;
  workflowType: WorkflowType | null;
  workflowInstanceId: string | null;
  sandboxRunId: string | null;
  repositoryId: string | null;
  fromState: string | null;
  toState: string | null;
  metadata: string | null;
  createdAt: number;
}

// ATTENTION_STATES are the states that read as a problem, whether or not anybody can
// still act on them; they are what paints a row red.
export const ATTENTION_STATES: readonly string[] = [
  'rr_unresolvable',
  'li_needs_human',
  'fi_needs_human',
  'lr_failed',
  'prm_attempts_exhausted',
];

// AWAITING_A_PERSON_STATES are the ones a person can actually move, which is what makes
// them a queue. `lr_failed` and `rr_unresolvable` are endings: no operator command
// reaches them, so listing them as work would be listing history.
export const AWAITING_A_PERSON_STATES: readonly string[] = [
  'li_needs_human',
  'fi_needs_human',
  'prm_attempts_exhausted',
];

// WORKING_STATES are the states that have a sandbox in flight.
const WORKING_STATES: readonly string[] = [
  'rr_routing',
  'li_implementing',
  'li_verifying',
  'fi_implementing',
  'fi_verifying',
  'lr_working',
  'prm_working',
];

// TERMINAL_STATES are the endings of the five machines in one list. The five machines
// prefix their states, so no ending is ambiguous across them.
export const TERMINAL_STATES: readonly string[] = [
  ...REQUEST_ROUTER_TERMINAL_STATES,
  ...LINEAR_IMPLEMENTER_TERMINAL_STATES,
  ...FIX_IMPLEMENTER_TERMINAL_STATES,
  ...LOG_REVIEWER_TERMINAL_STATES,
  ...PR_MAINTAINER_TERMINAL_STATES,
];

// CLOSED_STATES ended without an error and without the result the machine was after,
// which no surface should show the way it shows a merge.
const CLOSED_STATES: readonly string[] = [
  'li_abandoned',
  'li_dismissed',
  'fi_abandoned',
  'fi_discarded',
  'fi_dismissed',
  'prm_closed',
  'prm_dismissed',
];

export type WorkflowStateTone = 'working' | 'waiting' | 'attention' | 'closed' | 'done';

// workflowStateTone says how a state reads at a glance, so no surface has to know
// what any single state means.
export function workflowStateTone(workflowState: string): WorkflowStateTone {
  if (ATTENTION_STATES.includes(workflowState)) return 'attention';
  if (WORKING_STATES.includes(workflowState)) return 'working';
  if (CLOSED_STATES.includes(workflowState)) return 'closed';
  if (TERMINAL_STATES.includes(workflowState)) return 'done';
  return 'waiting';
}

export type WorkflowSubjectKind =
  | 'request'
  | 'linear_issue'
  | 'finding'
  | 'log_target'
  | 'pull_request';

// WorkflowInstanceSummary is any of the five machines in one shape, so a column a
// machine does not have comes back null.
export interface WorkflowInstanceSummary {
  workflowType: WorkflowType;
  workflowInstanceId: string;
  workflowState: string;
  repositoryId: string | null;
  repositoryFullName: string | null;
  subjectKind: WorkflowSubjectKind;
  subjectLabel: string;
  pullRequestNumber: number | null;
  attemptCount: number | null;
  iterationNumber: number | null;
  needsHumanReason: string | null;
  sandboxRunId: string | null;
  sandboxRunCount: number;
  lastRunState: SandboxRunState | null;
  lastRunEndedAt: number | null;
  stateChangedAt: number;
  createdAt: number;
}

export interface WorkflowInstanceFilter {
  workflowType?: WorkflowType;
  workflowTypes?: readonly WorkflowType[];
  workflowInstanceId?: string;
  workflowState?: string;
  repositoryId?: string;
  subjectSearch?: string;
  open?: boolean;
  awaitingAPerson?: boolean;
  changedSince?: number;
}

export interface WorkflowInstanceStateCount {
  workflowType: WorkflowType;
  workflowState: string;
  instanceCount: number;
}

// PageRequest pages by keyset: the cursor is the last row read, so a row written
// meanwhile never shifts a page.
export interface PageRequest {
  limit: number;
  cursor?: string;
}

export interface Page<T> {
  rows: T[];
  nextCursor: string | null;
}

export interface StateArrivalBucket {
  toState: string;
  bucketStart: number;
  arrivalCount: number;
}

export interface EventLogFilter {
  workflowType?: WorkflowType;
  workflowInstanceId?: string;
  sandboxRunId?: string;
  repositoryId?: string;
  eventTypePrefixes?: readonly string[];
  since?: number;
}

export interface RequestFilter {
  requestSource?: RequestSource;
  since?: number;
}

export interface RequestSummary extends RequestRouter {
  repositoryFullName: string | null;
}

// OurPullRequest is never re-read from GitHub, so every timestamp on it is one of
// our own transitions.
export interface OurPullRequest {
  repositoryId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  workflowType: WorkflowType;
  workflowInstanceId: string;
  workflowState: string;
  openedByWorkflowType: WorkflowType | null;
  openedByWorkflowInstanceId: string | null;
  createdAt: number;
  finishedAt: number | null;
}
