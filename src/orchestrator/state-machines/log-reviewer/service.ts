import type { Store } from '../../../store/store.js';
import type { LogReviewerState } from '../../../store/types.js';
import type { Locker, SandboxPool } from '../execution.js';
import {
  onPeriodicCheck,
  onSandboxRunFailed,
  onSandboxRunSucceeded,
  onScheduledScan,
  onSystemRecovery,
  type ScanTarget,
  type ScanOutcome,
} from './events.js';

export interface LogReviewerConfig {
  // scanWindowMs is how far back a scan reads, so a target scanned again inside it would
  // read the same logs twice.
  scanWindowMs: number;
  // checkWaitMs is how long each state waits between periodic checks; a state left out is
  // never checked, which is what the terminal states want.
  checkWaitMs: Partial<Record<LogReviewerState, number>>;
}

export interface LogReviewerStateEngineInterface {
  onScheduledScan(target: ScanTarget, requestRouterId?: string): Promise<Error | undefined>;
  onSandboxRunSucceeded(sandboxRunId: string, outcome: ScanOutcome): Promise<Error | undefined>;
  onSandboxRunFailed(sandboxRunId: string): Promise<Error | undefined>;
  onPeriodicCheck(logReviewerId: string): Promise<Error | undefined>;
  onSystemRecovery(logReviewerId: string): Promise<Error | undefined>;
}

export class LogReviewerStateEngine implements LogReviewerStateEngineInterface {
  constructor(
    readonly store: Store,
    readonly pool: SandboxPool,
    readonly locker: Locker,
    readonly config: LogReviewerConfig,
  ) {}

  onScheduledScan(target: ScanTarget, requestRouterId?: string): Promise<Error | undefined> {
    return onScheduledScan(this, target, requestRouterId);
  }

  onSandboxRunSucceeded(sandboxRunId: string, outcome: ScanOutcome): Promise<Error | undefined> {
    return onSandboxRunSucceeded(this, sandboxRunId, outcome);
  }

  onSandboxRunFailed(sandboxRunId: string): Promise<Error | undefined> {
    return onSandboxRunFailed(this, sandboxRunId);
  }

  onPeriodicCheck(logReviewerId: string): Promise<Error | undefined> {
    return onPeriodicCheck(this, logReviewerId);
  }

  onSystemRecovery(logReviewerId: string): Promise<Error | undefined> {
    return onSystemRecovery(this, logReviewerId);
  }
}
