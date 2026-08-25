import type { LinearImplementer, LinearImplementerState } from '../../../store/types.js';
import { asError } from '../execution.js';
import type { LinearImplementerStateEngine } from './service.js';

export type StateHandlerResult = [LinearImplementerState, Error?];

// handleStateLiPending owns no agent of its own: it hands the ticket to the state that
// does.
export function handleStateLiPending(
  _engine: LinearImplementerStateEngine,
  _instance: LinearImplementer,
): StateHandlerResult {
  return ['li_implementing'];
}

export function handleStateLiImplementing(
  engine: LinearImplementerStateEngine,
  instance: LinearImplementer,
): StateHandlerResult {
  return dispatchAgent(engine, instance, 'LinearImplementer', 'li_implementing');
}

export function handleStateLiVerifying(
  engine: LinearImplementerStateEngine,
  instance: LinearImplementer,
): StateHandlerResult {
  return dispatchAgent(engine, instance, 'LinearVerifier', 'li_verifying');
}

// dispatchAgent starts the seat this state owns, and is the one gate on the ticket's
// budget: whatever spent an iteration, nothing is dispatched past the last one.
function dispatchAgent(
  engine: LinearImplementerStateEngine,
  instance: LinearImplementer,
  agentName: string,
  state: LinearImplementerState,
): StateHandlerResult {
  // If we reached the max iterations, we need to stop and ask for human help.
  if (instance.iterationNumber > engine.config.maxIterations) {
    instance.needsHumanReason = 'iterations_exhausted';
    return ['li_needs_human'];
  }

  if (instance.sandboxRunId) {
    const existing = engine.store.getSandboxRun(instance.sandboxRunId);
    switch (existing?.runState) {
      // A live sandbox run means this was already done, which is what makes
      // calling the handler twice harmless.
      case 'pending':
      case 'running':
        return [state];
    }
  }

  // Asked before the row exists, so a full pool costs nothing to reap.
  if (!engine.pool.hasRoomFor('linear_implementer')) return [state];

  try {
    const sandboxRun = engine.store.startSandboxRun({
      agentName,
      workflowType: 'linear_implementer',
      workflowInstanceId: instance.id,
    });
    instance.sandboxRunId = sandboxRun.id;
    // The pool is in memory, so a crash between the row and this line leaves a
    // sandbox run in pending that the periodic check starts again.
    engine.pool.startSandbox(sandboxRun.id);
    return [state];
  } catch (error) {
    // The write failed, so nothing was started and staying here is correct;
    // the periodic check retries.
    return [state, asError(error)];
  }
}
