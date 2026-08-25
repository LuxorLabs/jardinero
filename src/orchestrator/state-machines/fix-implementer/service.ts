import type { Store } from '../../../store/store.js';
import type { WorkAnnouncer } from '../../work-announcer.js';
import type { FixImplementerState } from '../../../store/types.js';
import type {
  ExistingImplementationPr,
  ProblemSignature,
} from '../../../workflows/pr/implementation-pr-dedup.js';
import type { Locker, SandboxPool } from '../execution.js';
import type { GitHubReader } from '../pr-maintainer/service.js';
import type { GitHubWriter } from '../linear-implementer/service.js';
import {
  onFindingReported,
  onOperatorDismiss,
  onOperatorRetry,
  onPeriodicCheck,
  onPrClosed,
  onPrMerged,
  onSandboxRunFailed,
  onSandboxRunSucceeded,
  onSystemRecovery,
  type Finding,
  type PullRequestRef,
  type RunOutcome,
} from './events.js';

export interface GitHubImplementationPrReader {
  findOpenImplementationPullRequest(
    repositoryFullName: string,
    signature: ProblemSignature,
  ): Promise<ExistingImplementationPr | undefined>;
}

export interface FixImplementerConfig {
  // maxIterations bounds the passes one finding gets; a run that died without an outcome
  // spends one.
  maxIterations: number;
  // checkWaitMs is how long each state waits between periodic checks; a state left out is
  // never checked, which is what fi_needs_human wants.
  checkWaitMs: Partial<Record<FixImplementerState, number>>;
}

export interface FixImplementerStateEngineInterface {
  onFindingReported(finding: Finding, logReviewerId?: string): Promise<Error | undefined>;
  onSandboxRunSucceeded(sandboxRunId: string, outcome: RunOutcome): Promise<Error | undefined>;
  onSandboxRunFailed(sandboxRunId: string): Promise<Error | undefined>;
  onPrMerged(ref: PullRequestRef): Promise<Error | undefined>;
  onPrClosed(ref: PullRequestRef): Promise<Error | undefined>;
  onOperatorRetry(fixImplementerId: string): Promise<Error | undefined>;
  onOperatorDismiss(fixImplementerId: string): Promise<Error | undefined>;
  onPeriodicCheck(fixImplementerId: string): Promise<Error | undefined>;
  onSystemRecovery(fixImplementerId: string): Promise<Error | undefined>;
}

export class FixImplementerStateEngine implements FixImplementerStateEngineInterface {
  constructor(
    readonly store: Store,
    readonly pool: SandboxPool,
    readonly github: GitHubReader & GitHubWriter & GitHubImplementationPrReader,
    readonly locker: Locker,
    readonly config: FixImplementerConfig,
    readonly announcer?: WorkAnnouncer,
  ) {}

  onFindingReported(finding: Finding, logReviewerId?: string): Promise<Error | undefined> {
    return onFindingReported(this, finding, logReviewerId);
  }

  onSandboxRunSucceeded(sandboxRunId: string, outcome: RunOutcome): Promise<Error | undefined> {
    return onSandboxRunSucceeded(this, sandboxRunId, outcome);
  }

  onSandboxRunFailed(sandboxRunId: string): Promise<Error | undefined> {
    return onSandboxRunFailed(this, sandboxRunId);
  }

  onPrMerged(ref: PullRequestRef): Promise<Error | undefined> {
    return onPrMerged(this, ref);
  }

  onPrClosed(ref: PullRequestRef): Promise<Error | undefined> {
    return onPrClosed(this, ref);
  }

  onOperatorRetry(fixImplementerId: string): Promise<Error | undefined> {
    return onOperatorRetry(this, fixImplementerId);
  }

  onOperatorDismiss(fixImplementerId: string): Promise<Error | undefined> {
    return onOperatorDismiss(this, fixImplementerId);
  }

  onPeriodicCheck(fixImplementerId: string): Promise<Error | undefined> {
    return onPeriodicCheck(this, fixImplementerId);
  }

  onSystemRecovery(fixImplementerId: string): Promise<Error | undefined> {
    return onSystemRecovery(this, fixImplementerId);
  }
}
