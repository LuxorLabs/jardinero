import type { LinearImplementer, LinearImplementerState } from '../../../store/types.js';
import { asError, recordWorkflowStateChange, retrieveWorkConversation } from '../execution.js';
import { linearIssueConversationKey } from '../../work-announcer.js';
import type { LinearImplementerStateEngine } from './service.js';
import {
  handleStateLiImplementing,
  handleStateLiPending,
  handleStateLiVerifying,
} from './state-handlers.js';

export class UnsupportedStateError extends Error {
  constructor(state: string) {
    super(`unsupported state for linear implementer: ${state}`);
    this.name = 'UnsupportedStateError';
  }
}

// Cap on the state changes one call may make, so a handler that returns a state leading
// back to itself cannot loop forever.
const MAX_TRANSITIONS_PER_ENTRY = 16;

// runLinearImplementerFSM advances one ticket until it settles. A handler that returns
// the state it was given is how a state says it is waiting for something from outside.
export function runLinearImplementerFSM(
  engine: LinearImplementerStateEngine,
  instance: LinearImplementer,
): Error | undefined {
  let resultError: Error | undefined;

  for (let transitions = 0; ; transitions += 1) {
    if (transitions >= MAX_TRANSITIONS_PER_ENTRY) {
      return resultError ?? new Error(`linear implementer ${instance.id} did not settle`);
    }

    const state = instance.workflowState;
    let nextState: LinearImplementerState;
    let handlerError: Error | undefined;

    switch (state) {
      case 'li_pending':
        [nextState, handlerError] = handleStateLiPending(engine, instance);
        break;
      case 'li_implementing':
        [nextState, handlerError] = handleStateLiImplementing(engine, instance);
        break;
      case 'li_verifying':
        [nextState, handlerError] = handleStateLiVerifying(engine, instance);
        break;
      // Loop finished. li_needs_human waits for a person; li_waiting_pr waits
      // for the periodic check to see how the pull request ended.
      case 'li_needs_human':
      case 'li_waiting_pr':
      case 'li_done':
      case 'li_abandoned':
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
  engine: LinearImplementerStateEngine,
  instance: LinearImplementer,
  nextState: LinearImplementerState,
): Error | undefined {
  try {
    engine.store.setLinearImplementerState(instance.id, nextState, {
      linearSessionId: instance.linearSessionId,
      promptContext: instance.promptContext,
      pullRequestNumber: instance.pullRequestNumber,
      iterationNumber: instance.iterationNumber,
      verifiedCommitSha: instance.verifiedCommitSha,
      verifierVerdict: instance.verifierVerdict,
      verifierIssues: instance.verifierIssues,
      sandboxRunId: instance.sandboxRunId,
      needsHumanReason: instance.needsHumanReason,
    });
    recordWorkflowStateChange(engine.store, 'linear_implementer', instance, nextState);
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

// announceState says what the ticket's new state means to whoever is waiting, and stays
// quiet for the states nobody is waiting on.
function announceState(
  engine: LinearImplementerStateEngine,
  instance: LinearImplementer,
  nextState: LinearImplementerState,
): void {
  const announcer = engine.announcer;
  if (!announcer) return;
  const work = retrieveWorkConversation(engine.store, {
    key: linearIssueConversationKey(instance.linearIssueIdentifier),
    workflowInstanceId: instance.id,
    name: instance.linearIssueIdentifier,
    repositoryId: instance.repositoryId,
    requestRouterId: instance.requestRouterId,
  });
  const ticket = { identifier: instance.linearIssueIdentifier };
  switch (nextState) {
    case 'li_implementing':
      // Coming back from verification means the verifier turned the last pass down.
      if (instance.workflowState === 'li_verifying') {
        announcer.ticketRejectedByVerifier(work, { ...ticket, attempt: instance.iterationNumber });
      } else {
        announcer.ticketImplementationStarted(work, ticket);
      }
      return;
    case 'li_verifying':
      announcer.ticketVerificationStarted(work, ticket);
      return;
    case 'li_needs_human':
      announcer.ticketParked(work, { ...ticket, reason: instance.needsHumanReason });
      return;
    // The pull request is the maintainer's to talk about, from the moment this machine
    // releases it until it ends.
    default:
      return;
  }
}
