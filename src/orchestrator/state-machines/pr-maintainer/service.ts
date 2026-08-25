import type { Store } from '../../../store/store.js';
import type { WorkAnnouncer } from '../../work-announcer.js';
import type { AgentPullRequestRule } from '../../../workflows/pr/pr-maintainer.js';
import type { Lock, Locker, SandboxPool } from '../execution.js';
import type { PrMaintainerState } from '../../../store/types.js';
import {
  onOperatorDismiss,
  onOperatorRetry,
  onPeriodicCheck,
  onPrCICompleted,
  onPrClosed,
  onPrComment,
  onPrDiscovered,
  onPrToFollow,
  onPrMerged,
  onPrReadyForReview,
  onPrReopened,
  onPrSynchronize,
  onSandboxRunFailed,
  onSandboxRunSucceeded,
  onSystemRecovery,
  type CiData,
  type CommentData,
  type PullRequestFacts,
  type PullRequestRef,
} from './events.js';

export type { Lock, Locker, SandboxPool };

export interface PullRequestSnapshot {
  state: 'open' | 'merged' | 'closed';
  headCommitSha: string;
  checksAreRed: boolean;
  hasUnresolvedReviewThreads: boolean;
}

export interface GitHubReader {
  readPullRequest(
    repositoryFullName: string,
    pullRequestNumber: number,
  ): Promise<PullRequestSnapshot>;
}

export interface PickedUpComment {
  commentType: 'issue' | 'review';
  commentExternalId: string;
}

// GitHubCommentWriter is what this machine changes on GitHub: the mark on a comment it
// took. It answers an error instead of throwing, so a failure is something to record.
export interface GitHubCommentWriter {
  markCommentPickedUp(
    repositoryFullName: string,
    comment: PickedUpComment,
  ): Promise<Error | undefined>;
}

export interface PrMaintainerConfig {
  // maxAttempts bounds the passes one pull request gets; only a pass that moved its head
  // spends one.
  maxAttempts: number;
  // agentPullRequest is what makes a pull request ours: the branch the agent pushes to, or
  // the label an operator puts on one they want maintained.
  agentPullRequest: AgentPullRequestRule;
  // maxRepliesPerThread bounds the answers one thread gets; the backstop for a reply loop
  // the self-comment filter misses.
  maxRepliesPerThread: number;
  // checkWaitMs is how long each state waits between periodic checks; a state left out is
  // never checked, which is what prm_attempts_exhausted wants.
  checkWaitMs: Partial<Record<PrMaintainerState, number>>;
}

export interface PrMaintainerStateEngineInterface {
  onPrReadyForReview(data: PullRequestFacts, requestRouterId?: string): Promise<Error | undefined>;
  onPrToFollow(ref: PullRequestRef, requestRouterId?: string): Promise<Error | undefined>;
  onPrDiscovered(data: PullRequestFacts): Promise<Error | undefined>;
  onPrReopened(data: PullRequestFacts): Promise<Error | undefined>;
  onPrComment(data: CommentData): Promise<Error | undefined>;
  onPrCICompleted(data: CiData): Promise<Error | undefined>;
  onPrSynchronize(ref: PullRequestRef, headCommitSha: string): Promise<Error | undefined>;
  onPrMerged(ref: PullRequestRef): Promise<Error | undefined>;
  onPrClosed(ref: PullRequestRef): Promise<Error | undefined>;
  onSandboxRunSucceeded(sandboxRunId: string): Promise<Error | undefined>;
  onSandboxRunFailed(sandboxRunId: string): Promise<Error | undefined>;
  onOperatorRetry(prMaintainerId: string): Promise<Error | undefined>;
  onOperatorDismiss(prMaintainerId: string): Promise<Error | undefined>;
  onPeriodicCheck(prMaintainerId: string): Promise<Error | undefined>;
  onSystemRecovery(prMaintainerId: string): Promise<Error | undefined>;
}

// PrMaintainerStateEngine holds everything the machine needs, the same as the MCA
// TransactionStateEngine: the entry points, the loop and the state handlers are methods
// on it, split across files. TypeScript cannot spread a class over several files, so
// each method delegates to a function taking the engine as its first argument, which is
// what a Go receiver is. The other four machines are built the same way.
export class PrMaintainerStateEngine implements PrMaintainerStateEngineInterface {
  constructor(
    readonly store: Store,
    readonly pool: SandboxPool,
    readonly github: GitHubReader & GitHubCommentWriter,
    readonly locker: Locker,
    readonly config: PrMaintainerConfig,
    readonly announcer?: WorkAnnouncer,
  ) {}

  onPrReadyForReview(data: PullRequestFacts, requestRouterId?: string): Promise<Error | undefined> {
    return onPrReadyForReview(this, data, requestRouterId);
  }

  onPrToFollow(ref: PullRequestRef, requestRouterId?: string): Promise<Error | undefined> {
    return onPrToFollow(this, ref, requestRouterId);
  }

  onPrDiscovered(data: PullRequestFacts): Promise<Error | undefined> {
    return onPrDiscovered(this, data);
  }

  onPrReopened(data: PullRequestFacts): Promise<Error | undefined> {
    return onPrReopened(this, data);
  }

  onPrComment(data: CommentData): Promise<Error | undefined> {
    return onPrComment(this, data);
  }

  onPrCICompleted(data: CiData): Promise<Error | undefined> {
    return onPrCICompleted(this, data);
  }

  onPrSynchronize(ref: PullRequestRef, headCommitSha: string): Promise<Error | undefined> {
    return onPrSynchronize(this, ref, headCommitSha);
  }

  onPrMerged(ref: PullRequestRef): Promise<Error | undefined> {
    return onPrMerged(this, ref);
  }

  onPrClosed(ref: PullRequestRef): Promise<Error | undefined> {
    return onPrClosed(this, ref);
  }

  onSandboxRunSucceeded(sandboxRunId: string): Promise<Error | undefined> {
    return onSandboxRunSucceeded(this, sandboxRunId);
  }

  onSandboxRunFailed(sandboxRunId: string): Promise<Error | undefined> {
    return onSandboxRunFailed(this, sandboxRunId);
  }

  onOperatorRetry(prMaintainerId: string): Promise<Error | undefined> {
    return onOperatorRetry(this, prMaintainerId);
  }

  onOperatorDismiss(prMaintainerId: string): Promise<Error | undefined> {
    return onOperatorDismiss(this, prMaintainerId);
  }

  onPeriodicCheck(prMaintainerId: string): Promise<Error | undefined> {
    return onPeriodicCheck(this, prMaintainerId);
  }

  onSystemRecovery(prMaintainerId: string): Promise<Error | undefined> {
    return onSystemRecovery(this, prMaintainerId);
  }
}
