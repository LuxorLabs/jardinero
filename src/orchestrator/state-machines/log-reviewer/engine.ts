import type { LogReviewer, LogReviewerState } from '../../../store/types.js';
import { asError, recordWorkflowStateChange } from '../execution.js';
import type { LogReviewerStateEngine } from './service.js';
import { handleStateLrPending } from './state-handlers.js';

export class UnsupportedStateError extends Error {
  constructor(state: string) {
    super(`unsupported state for log reviewer: ${state}`);
    this.name = 'UnsupportedStateError';
  }
}

// Cap on the state changes one call may make, so a handler that returns a state leading
// back to itself cannot loop forever.
const MAX_TRANSITIONS_PER_ENTRY = 16;

// runLogReviewerFSM advances one scan until it settles. A handler that returns the
// state it was given is how a state says it is waiting for something from outside.
export function runLogReviewerFSM(
  engine: LogReviewerStateEngine,
  instance: LogReviewer,
): Error | undefined {
  let resultError: Error | undefined;

  for (let transitions = 0; ; transitions += 1) {
    if (transitions >= MAX_TRANSITIONS_PER_ENTRY) {
      return resultError ?? new Error(`log reviewer ${instance.id} did not settle`);
    }

    const state = instance.workflowState;
    let nextState: LogReviewerState;
    let handlerError: Error | undefined;

    switch (state) {
      case 'lr_pending':
        [nextState, handlerError] = handleStateLrPending(engine, instance);
        break;
      // Loop finished. lr_working waits for the outcome of its sandbox run.
      case 'lr_working':
      case 'lr_done':
      case 'lr_failed':
        return resultError;
      default:
        return resultError ?? new UnsupportedStateError(state);
    }

    // The first error is the one reported up, but the state is still written.
    if (!resultError && handlerError) resultError = handlerError;

    const writeError = setState(engine, instance, nextState);
    // Breaking out on a write failure is what stops an endless retry of a
    // transition that cannot be persisted.
    if (writeError) return resultError ?? writeError;

    if (nextState === state) return resultError;
  }
}

// setState writes the whole instance, not only its state, so whatever a handler changed
// on the way is persisted with the transition.
export function setState(
  engine: LogReviewerStateEngine,
  instance: LogReviewer,
  nextState: LogReviewerState,
): Error | undefined {
  try {
    engine.store.setLogReviewerState(instance.id, nextState, {
      sandboxRunId: instance.sandboxRunId,
      findingCount: instance.findingCount,
    });
    recordWorkflowStateChange(engine.store, 'log_reviewer', instance, nextState);
    if (nextState !== instance.workflowState) instance.stateChangedAt = Date.now();
    instance.workflowState = nextState;
    return undefined;
  } catch (error) {
    return asError(error);
  }
}
