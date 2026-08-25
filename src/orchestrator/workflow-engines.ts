import type {
  FixImplementerState,
  LinearImplementerState,
  LogReviewerState,
  PrMaintainerState,
  RequestRouterState,
} from '../store/types.js';

// PeriodicallyCheckedWorkflow is a machine as the clock and the boot recovery see it:
// the cadence per state, and the two entry points they call.
export interface PeriodicallyCheckedWorkflow<State extends string> {
  readonly config: { readonly checkWaitMs: Partial<Record<State, number>> };
  onPeriodicCheck(workflowInstanceId: string): Promise<Error | undefined>;
  onSystemRecovery(workflowInstanceId: string): Promise<Error | undefined>;
}

// WorkflowEngines is the five machines, each with the states it can be checked in.
export interface WorkflowEngines {
  requestRouter: PeriodicallyCheckedWorkflow<RequestRouterState>;
  linearImplementer: PeriodicallyCheckedWorkflow<LinearImplementerState>;
  fixImplementer: PeriodicallyCheckedWorkflow<FixImplementerState>;
  prMaintainer: PeriodicallyCheckedWorkflow<PrMaintainerState>;
  logReviewer: PeriodicallyCheckedWorkflow<LogReviewerState>;
}
