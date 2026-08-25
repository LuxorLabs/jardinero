import type { FixImplementer, FixImplementerState } from '../../../store/types.js';
import { asError, countConsecutiveLostRuns } from '../execution.js';
import type { FixImplementerStateEngine } from './service.js';

export type StateHandlerResult = [FixImplementerState, Error?];

// handleStateFiPending owns no agent of its own: it hands the finding to the state that
// does.
export function handleStateFiPending(
  _engine: FixImplementerStateEngine,
  _instance: FixImplementer,
): StateHandlerResult {
  return ['fi_implementing'];
}

export function handleStateFiImplementing(
  engine: FixImplementerStateEngine,
  instance: FixImplementer,
): StateHandlerResult {
  if (instance.sandboxRunId) {
    const existing = engine.store.getSandboxRun(instance.sandboxRunId);
    switch (existing?.runState) {
      // A live sandbox run means this was already done, which is what makes
      // calling the handler twice harmless.
      case 'pending':
      case 'running':
        return ['fi_implementing'];
    }
  }

  // Asked before the row exists, so a full pool costs nothing to reap.
  if (!engine.pool.hasRoomFor('fix_implementer')) return ['fi_implementing'];

  // Creating the sandbox run, taking the lock and recording it on the instance
  // happen in one transaction, so a crash in the middle leaves no half-built
  // work.
  try {
    // Counted from when the finding entered this state, so a person retrying an exhausted
    // one gets a budget the immutable run history cannot spend for them.
    if (
      countConsecutiveLostRuns(
        engine.store,
        'fix_implementer',
        instance.id,
        instance.stateChangedAt,
      ) > engine.config.maxIterations
    ) {
      instance.needsHumanReason = 'run_failed';
      return ['fi_needs_human'];
    }
    const sandboxRun = engine.store.startSandboxRun({
      agentName: 'FixImplementer',
      workflowType: 'fix_implementer',
      workflowInstanceId: instance.id,
    });
    instance.sandboxRunId = sandboxRun.id;
    // The pool is in memory, so a crash between the row and this line leaves a
    // sandbox run in pending that the periodic check starts again.
    engine.pool.startSandbox(sandboxRun.id);
    return ['fi_implementing'];
  } catch (error) {
    // The write failed, so nothing was started and staying here is correct;
    // the periodic check retries.
    return ['fi_implementing', asError(error)];
  }
}

// handleStateFiVerifying records that nothing was verified and waits: the release that
// leaves this state is done by the periodic check, which can call GitHub.
export function handleStateFiVerifying(
  _engine: FixImplementerStateEngine,
  instance: FixImplementer,
): StateHandlerResult {
  // TODO: we don't have a custom verifier for this workflow, so we just mark it as
  // ok and move on.
  instance.verifierVerdict = null;
  instance.verifierIssues = 'not_verified';
  return ['fi_verifying'];
}
