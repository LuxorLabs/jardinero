import type { PrMaintainer, PrMaintainerState } from '../../../store/types.js';
import type { PrMaintainerStateEngine } from './service.js';
import { type WorkConversation, linearIssueConversationKey } from '../../work-announcer.js';
import { asError, recordWorkflowStateChange, retrieveWorkConversation } from '../execution.js';
import { handleStatePrmPending, handleStatePrmWaiting } from './state-handlers.js';

export class UnsupportedStateError extends Error {
  constructor(state: string) {
    super(`unsupported state for pr maintainer: ${state}`);
    this.name = 'UnsupportedStateError';
  }
}

// Cap on the state changes one call may make, so a handler that returns a state leading
// back to itself cannot loop forever.
const MAX_TRANSITIONS_PER_ENTRY = 16;

// runPrMaintainerFSM advances one pull request until it settles. A handler that returns
// the state it was given is how a state says it is waiting for something from outside.
export function runPrMaintainerFSM(
  engine: PrMaintainerStateEngine,
  instance: PrMaintainer,
): Error | undefined {
  let resultError: Error | undefined;

  for (let transitions = 0; ; transitions += 1) {
    if (transitions >= MAX_TRANSITIONS_PER_ENTRY) {
      return resultError ?? new Error(`pr maintainer ${instance.id} did not settle`);
    }

    const state = instance.workflowState;
    let nextState: PrMaintainerState;
    let handlerError: Error | undefined;

    switch (state) {
      case 'prm_pending':
        [nextState, handlerError] = handleStatePrmPending(engine, instance);
        break;
      case 'prm_waiting':
        [nextState, handlerError] = handleStatePrmWaiting(engine, instance);
        break;
      // Loop finished. prm_working waits for the outcome of its sandbox run,
      // which is what keeps a second agent off the same pull request; the open
      // failure waits for a person.
      case 'prm_working':
      case 'prm_attempts_exhausted':
      case 'prm_merged':
      case 'prm_closed':
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
  engine: PrMaintainerStateEngine,
  instance: PrMaintainer,
  nextState: PrMaintainerState,
): Error | undefined {
  try {
    engine.store.setPrMaintainerState(instance.id, nextState, {
      sandboxRunId: instance.sandboxRunId,
      needsHumanReason: instance.needsHumanReason,
      attemptCount: instance.attemptCount,
      lastActedCommitSha: instance.lastActedCommitSha ?? undefined,
    });
    recordWorkflowStateChange(engine.store, 'pr_maintainer', instance, nextState);
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

// announceState says what the pull request's new state means to whoever is waiting, and
// stays quiet for the states nobody is waiting on.
function announceState(
  engine: PrMaintainerStateEngine,
  instance: PrMaintainer,
  nextState: PrMaintainerState,
): void {
  const announcer = engine.announcer;
  if (!announcer) return;
  const work = retrievePullRequestConversation(engine, instance);
  const pull = { number: instance.pullRequestNumber };
  switch (nextState) {
    case 'prm_attempts_exhausted':
      announcer.pullRequestMaintenanceParked(work, { ...pull, reason: instance.needsHumanReason });
      return;
    case 'prm_merged':
      announcer.pullRequestMerged(work, pull);
      return;
    case 'prm_closed':
      announcer.pullRequestClosed(work, pull);
      return;
    default:
      return;
  }
}

// retrievePullRequestConversation answers where this pull request is talked about, which is
// the ticket's own conversation when a ticket opened it, so one piece of work stays in one
// place.
export function retrievePullRequestConversation(
  engine: PrMaintainerStateEngine,
  instance: PrMaintainer,
): WorkConversation {
  const ticket = engine.store.findLinearImplementerByPullRequest(
    instance.repositoryId,
    instance.pullRequestNumber,
  );
  return retrieveWorkConversation(engine.store, {
    key: ticket
      ? linearIssueConversationKey(ticket.linearIssueIdentifier)
      : `pull_request:${instance.repositoryId}:${instance.pullRequestNumber}`,
    name: `#${instance.pullRequestNumber}`,
    workflowInstanceId: ticket?.id ?? instance.id,
    repositoryId: instance.repositoryId,
    requestRouterId: ticket?.requestRouterId ?? instance.requestRouterId,
  });
}
