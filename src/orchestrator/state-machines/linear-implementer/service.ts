import type { Store } from '../../../store/store.js';
import type { WorkAnnouncer } from '../../work-announcer.js';
import type { LinearImplementerState } from '../../../store/types.js';
import type { Locker, SandboxPool } from '../execution.js';
import type { GitHubReader } from '../pr-maintainer/service.js';
import {
  onIssueAssigned,
  onIssueCommented,
  onOperatorDismiss,
  onOperatorRetry,
  onOperatorRetryVerification,
  onPeriodicCheck,
  onPrClosed,
  onPrComment,
  onPrMerged,
  onSandboxRunFailed,
  onSandboxRunSucceeded,
  onSystemRecovery,
  type CommentData,
  type IssueRef,
  type PullRequestRef,
  type RunOutcome,
} from './events.js';

// GitHubWriter is what this machine changes on GitHub. It answers an error instead
// of throwing, so a failure is a state the machine can move to.
export interface GitHubWriter {
  markReadyForReview(
    repositoryFullName: string,
    pullRequestNumber: number,
  ): Promise<Error | undefined>;
}

export interface LinearImplementerConfig {
  // maxIterations bounds the passes one ticket gets; a rejection, a missing verdict and a
  // lost run each spend one.
  maxIterations: number;
  // checkWaitMs is how long each state waits between periodic checks; a state left out is
  // never checked, which is what li_needs_human wants.
  checkWaitMs: Partial<Record<LinearImplementerState, number>>;
}

export interface LinearImplementerStateEngineInterface {
  onIssueAssigned(ref: IssueRef, requestRouterId?: string): Promise<Error | undefined>;
  onIssueCommented(ref: IssueRef): Promise<Error | undefined>;
  onPrComment(data: CommentData): Promise<Error | undefined>;
  onPrMerged(ref: PullRequestRef): Promise<Error | undefined>;
  onPrClosed(ref: PullRequestRef): Promise<Error | undefined>;
  onSandboxRunSucceeded(sandboxRunId: string, outcome: RunOutcome): Promise<Error | undefined>;
  onSandboxRunFailed(sandboxRunId: string): Promise<Error | undefined>;
  onOperatorRetry(linearImplementerId: string): Promise<Error | undefined>;
  onOperatorRetryVerification(linearImplementerId: string): Promise<Error | undefined>;
  onOperatorDismiss(linearImplementerId: string): Promise<Error | undefined>;
  onPeriodicCheck(linearImplementerId: string): Promise<Error | undefined>;
  onSystemRecovery(linearImplementerId: string): Promise<Error | undefined>;
}

export class LinearImplementerStateEngine implements LinearImplementerStateEngineInterface {
  constructor(
    readonly store: Store,
    readonly pool: SandboxPool,
    readonly github: GitHubReader & GitHubWriter,
    readonly locker: Locker,
    readonly config: LinearImplementerConfig,
    readonly announcer?: WorkAnnouncer,
  ) {}

  onIssueAssigned(ref: IssueRef, requestRouterId?: string): Promise<Error | undefined> {
    return onIssueAssigned(this, ref, requestRouterId);
  }

  onIssueCommented(ref: IssueRef): Promise<Error | undefined> {
    return onIssueCommented(this, ref);
  }

  onPrComment(data: CommentData): Promise<Error | undefined> {
    return onPrComment(this, data);
  }

  onPrMerged(ref: PullRequestRef): Promise<Error | undefined> {
    return onPrMerged(this, ref);
  }

  onPrClosed(ref: PullRequestRef): Promise<Error | undefined> {
    return onPrClosed(this, ref);
  }

  onSandboxRunSucceeded(sandboxRunId: string, outcome: RunOutcome): Promise<Error | undefined> {
    return onSandboxRunSucceeded(this, sandboxRunId, outcome);
  }

  onSandboxRunFailed(sandboxRunId: string): Promise<Error | undefined> {
    return onSandboxRunFailed(this, sandboxRunId);
  }

  onOperatorRetry(linearImplementerId: string): Promise<Error | undefined> {
    return onOperatorRetry(this, linearImplementerId);
  }

  onOperatorRetryVerification(linearImplementerId: string): Promise<Error | undefined> {
    return onOperatorRetryVerification(this, linearImplementerId);
  }

  onOperatorDismiss(linearImplementerId: string): Promise<Error | undefined> {
    return onOperatorDismiss(this, linearImplementerId);
  }

  onPeriodicCheck(linearImplementerId: string): Promise<Error | undefined> {
    return onPeriodicCheck(this, linearImplementerId);
  }

  onSystemRecovery(linearImplementerId: string): Promise<Error | undefined> {
    return onSystemRecovery(this, linearImplementerId);
  }
}
