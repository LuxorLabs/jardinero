import type { PrMaintainer, PrMaintainerState } from '../../../store/types.js';
import type { PrMaintainerStateEngine } from './service.js';
import { asError } from '../execution.js';

export type StateHandlerResult = [PrMaintainerState, Error?];

// handleStatePrmPending dispatches the maintenance pass, or gives up when the attempts
// are spent.
export function handleStatePrmPending(
  engine: PrMaintainerStateEngine,
  instance: PrMaintainer,
): StateHandlerResult {
  if (instance.sandboxRunId) {
    const existing = engine.store.getSandboxRun(instance.sandboxRunId);
    switch (existing?.runState) {
      // A live sandbox run means this was already done, which is what makes
      // calling the handler twice harmless.
      case 'pending':
      case 'running':
        return ['prm_working'];
    }
  }

  if (instance.attemptCount >= engine.config.maxAttempts) {
    instance.needsHumanReason = 'attempts_exhausted';
    return ['prm_attempts_exhausted'];
  }

  // Asked before the row exists, so a full pool costs nothing to reap.
  if (!engine.pool.hasRoomFor('pr_maintainer')) return ['prm_pending'];

  try {
    const sandboxRun = engine.store.startSandboxRun({
      agentName: 'PrMaintainer',
      workflowType: 'pr_maintainer',
      workflowInstanceId: instance.id,
    });
    instance.sandboxRunId = sandboxRun.id;
    instance.attemptCount += 1;
    // The pool is in memory, so a crash between the row and this line leaves a
    // sandbox run in pending that the periodic check starts again.
    if (!engine.pool.startSandbox(sandboxRun.id)) {
      // The row is released with the pointer: a run left pending is reaped as
      // orphaned later, and that reads as a run that failed instead of one that
      // never started.
      engine.store.finishSandboxRun(sandboxRun.id, { runState: 'skipped' });
      instance.sandboxRunId = null;
      return ['prm_pending'];
    }
    return ['prm_working'];
  } catch (error) {
    // The write failed, so nothing was started and staying here is correct;
    // the periodic check retries.
    return ['prm_pending', asError(error)];
  }
}

// handleStatePrmWaiting takes a request that arrived while a pass was in flight and
// nobody consumed.
export function handleStatePrmWaiting(
  engine: PrMaintainerStateEngine,
  instance: PrMaintainer,
): StateHandlerResult {
  const unconsumed = engine.store.listUnconsumedRequests(
    'pull_request',
    String(instance.pullRequestNumber),
    instance.repositoryId,
  );
  if (unconsumed.length > 0) return ['prm_pending'];
  return ['prm_waiting'];
}
