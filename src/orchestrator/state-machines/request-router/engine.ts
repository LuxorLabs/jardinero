import type { RequestRouter, RequestRouterState } from '../../../store/types.js';
import { asError, recordWorkflowStateChange, retrieveWorkConversation } from '../execution.js';
import type { RequestRouterStateEngine } from './service.js';
import { handleStateRrPending } from './state-handlers.js';

export class UnsupportedStateError extends Error {
  constructor(state: string) {
    super(`unsupported state for request router: ${state}`);
    this.name = 'UnsupportedStateError';
  }
}

// Cap on the state changes one call may make, so a handler that returns a state leading
// back to itself cannot loop forever.
const MAX_TRANSITIONS_PER_ENTRY = 16;

// runRequestRouterFSM advances one request until it settles. A handler that returns the
// state it was given is how a state says it is waiting for something from outside.
export function runRequestRouterFSM(
  engine: RequestRouterStateEngine,
  instance: RequestRouter,
): Error | undefined {
  let resultError: Error | undefined;

  for (let transitions = 0; ; transitions += 1) {
    if (transitions >= MAX_TRANSITIONS_PER_ENTRY) {
      return resultError ?? new Error(`request router ${instance.id} did not settle`);
    }

    const state = instance.workflowState;
    let nextState: RequestRouterState;
    let handlerError: Error | undefined;

    switch (state) {
      case 'rr_pending':
        [nextState, handlerError] = handleStateRrPending(engine, instance);
        break;
      // Loop finished. rr_routing waits for the routing agent to come back.
      case 'rr_routing':
      case 'rr_resolved':
      case 'rr_unresolvable':
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
  engine: RequestRouterStateEngine,
  instance: RequestRouter,
  nextState: RequestRouterState,
): Error | undefined {
  try {
    engine.store.setRequestState(instance.id, nextState, {
      repositoryId: instance.repositoryId ?? undefined,
      subjectType: instance.subjectType ?? undefined,
      subjectExternalId: instance.subjectExternalId ?? undefined,
      resolutionNote: instance.resolutionNote ?? undefined,
      sandboxRunId: instance.sandboxRunId,
    });
    recordWorkflowStateChange(engine.store, 'request_router', instance, nextState);
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

// announceState says what the request's new state means to whoever asked, and stays quiet
// for the states nobody is waiting on.
function announceState(
  engine: RequestRouterStateEngine,
  instance: RequestRouter,
  nextState: RequestRouterState,
): void {
  const announcer = engine.announcer;
  if (!announcer) return;
  // A request nobody could place still names the repository it was about, and without one
  // there is nowhere to answer.
  if (nextState !== 'rr_unresolvable' || !instance.repositoryId) return;
  announcer.requestUnresolvable(
    retrieveWorkConversation(engine.store, {
      key: `request_router:${instance.id}`,
      workflowInstanceId: instance.id,
      name: 'that request',
      repositoryId: instance.repositoryId,
      requestRouterId: instance.id,
    }),
    { questions: instance.resolutionNote },
  );
}
