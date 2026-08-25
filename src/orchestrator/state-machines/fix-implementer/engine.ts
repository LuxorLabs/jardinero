import type { FixImplementer, FixImplementerState } from '../../../store/types.js';
import { asError, recordWorkflowStateChange, retrieveWorkConversation } from '../execution.js';
import type { FixImplementerStateEngine } from './service.js';
import {
  handleStateFiImplementing,
  handleStateFiPending,
  handleStateFiVerifying,
} from './state-handlers.js';

export class UnsupportedStateError extends Error {
  constructor(state: string) {
    super(`unsupported state for fix implementer: ${state}`);
    this.name = 'UnsupportedStateError';
  }
}

// Cap on the state changes one call may make, so a handler that returns a state leading
// back to itself cannot loop forever.
const MAX_TRANSITIONS_PER_ENTRY = 16;

// runFixImplementerFSM advances one finding until it settles. A handler that returns
// the state it was given is how a state says it is waiting for something from outside.
export function runFixImplementerFSM(
  engine: FixImplementerStateEngine,
  instance: FixImplementer,
): Error | undefined {
  let resultError: Error | undefined;

  for (let transitions = 0; ; transitions += 1) {
    if (transitions >= MAX_TRANSITIONS_PER_ENTRY) {
      return resultError ?? new Error(`fix implementer ${instance.id} did not settle`);
    }

    const state = instance.workflowState;
    let nextState: FixImplementerState;
    let handlerError: Error | undefined;

    switch (state) {
      case 'fi_pending':
        [nextState, handlerError] = handleStateFiPending(engine, instance);
        break;
      case 'fi_implementing':
        [nextState, handlerError] = handleStateFiImplementing(engine, instance);
        break;
      case 'fi_verifying':
        [nextState, handlerError] = handleStateFiVerifying(engine, instance);
        break;
      // Loop finished. fi_needs_human waits for a person; fi_verifying and
      // fi_waiting_pr wait for the periodic check, which is what calls GitHub.
      case 'fi_needs_human':
      case 'fi_waiting_pr':
      case 'fi_discarded':
      case 'fi_done':
      case 'fi_abandoned':
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
  engine: FixImplementerStateEngine,
  instance: FixImplementer,
  nextState: FixImplementerState,
): Error | undefined {
  try {
    engine.store.setFixImplementerState(instance.id, nextState, {
      pullRequestNumber: instance.pullRequestNumber,
      verifiedCommitSha: instance.verifiedCommitSha,
      verifierVerdict: instance.verifierVerdict,
      verifierIssues: instance.verifierIssues,
      sandboxRunId: instance.sandboxRunId,
      needsHumanReason: instance.needsHumanReason,
      discardReason: instance.discardReason,
    });
    recordWorkflowStateChange(engine.store, 'fix_implementer', instance, nextState);
    if (nextState !== instance.workflowState) {
      instance.stateChangedAt = Date.now();
      announceState(engine, instance, nextState);
    }
    instance.workflowState = nextState;
    return undefined;
  } catch (error) {
    return asError(error);
  }
}

// announceState asks for a person when the fix cannot go on. What became of its pull
// request is the maintainer's to say, and a finding nobody has to act on is not news.
function announceState(
  engine: FixImplementerStateEngine,
  instance: FixImplementer,
  nextState: FixImplementerState,
): void {
  const announcer = engine.announcer;
  if (!announcer) return;
  if (nextState !== 'fi_needs_human') return;
  announcer.fixParked(
    retrieveWorkConversation(engine.store, {
      key: `fix_implementer:${instance.id}`,
      workflowInstanceId: instance.id,
      name: instance.serviceName ?? instance.findingFingerprint,
      repositoryId: instance.repositoryId,
    }),
    { reason: instance.needsHumanReason },
  );
}
