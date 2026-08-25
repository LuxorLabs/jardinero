import type { CreateRequestInput, Store } from '../../../store/store.js';
import type { WorkAnnouncer } from '../../work-announcer.js';
import type { RequestRouterState } from '../../../store/types.js';
import type { Locker, SandboxPool } from '../execution.js';
import {
  onPeriodicCheck,
  onRequestReceived,
  onSandboxRunFailed,
  onSandboxRunSucceeded,
  onSystemRecovery,
  type RoutingOutcome,
} from './events.js';

export type { CreateRequestInput };

export interface RequestRouterConfig {
  // checkWaitMs is how long each state waits between periodic checks; a state left out is
  // never checked, which is what the terminal states want.
  checkWaitMs: Partial<Record<RequestRouterState, number>>;
}

export interface RequestRouterStateEngineInterface {
  onRequestReceived(input: CreateRequestInput): Promise<Error | undefined>;
  onSandboxRunSucceeded(sandboxRunId: string, outcome: RoutingOutcome): Promise<Error | undefined>;
  onSandboxRunFailed(sandboxRunId: string): Promise<Error | undefined>;
  onPeriodicCheck(requestRouterId: string): Promise<Error | undefined>;
  onSystemRecovery(requestRouterId: string): Promise<Error | undefined>;
}

export class RequestRouterStateEngine implements RequestRouterStateEngineInterface {
  constructor(
    readonly store: Store,
    readonly pool: SandboxPool,
    readonly locker: Locker,
    readonly config: RequestRouterConfig,
    readonly announcer?: WorkAnnouncer,
  ) {}

  onRequestReceived(input: CreateRequestInput): Promise<Error | undefined> {
    return onRequestReceived(this, input);
  }

  onSandboxRunSucceeded(sandboxRunId: string, outcome: RoutingOutcome): Promise<Error | undefined> {
    return onSandboxRunSucceeded(this, sandboxRunId, outcome);
  }

  onSandboxRunFailed(sandboxRunId: string): Promise<Error | undefined> {
    return onSandboxRunFailed(this, sandboxRunId);
  }

  onPeriodicCheck(requestRouterId: string): Promise<Error | undefined> {
    return onPeriodicCheck(this, requestRouterId);
  }

  onSystemRecovery(requestRouterId: string): Promise<Error | undefined> {
    return onSystemRecovery(this, requestRouterId);
  }
}
