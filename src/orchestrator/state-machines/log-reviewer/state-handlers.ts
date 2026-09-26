import type { LogReviewer, LogReviewerState } from '../../../store/types.js';
import { asError, countConsecutiveLostRuns } from '../execution.js';
import type { LogReviewerStateEngine } from './service.js';

export type StateHandlerResult = [LogReviewerState, Error?];

export function handleStateLrPending(
  engine: LogReviewerStateEngine,
  instance: LogReviewer,
): StateHandlerResult {
  if (instance.sandboxRunId) {
    const existing = engine.store.getSandboxRun(instance.sandboxRunId);
    switch (existing?.runState) {
      // A live sandbox run means this was already done, which is what makes
      // calling the handler twice harmless.
      case 'pending':
      case 'running':
        return ['lr_working'];
    }
  }

  // Asked before the row exists, so a full pool costs nothing to reap.
  if (!engine.pool.hasRoomFor('log_reviewer')) return ['lr_pending'];

  try {
    // Counted from when the scan opened: every failed pass returns it to this state, so its
    // stateChangedAt would hand each pass a fresh budget.
    if (
      countConsecutiveLostRuns(engine.store, 'log_reviewer', instance.id, instance.createdAt) >
      engine.config.maxIterations
    ) {
      return ['lr_failed'];
    }
    const sandboxRun = engine.store.startSandboxRun({
      agentName: 'LogReviewer',
      workflowType: 'log_reviewer',
      workflowInstanceId: instance.id,
    });
    instance.sandboxRunId = sandboxRun.id;
    // The pool is in memory, so a crash between the row and this line leaves a
    // sandbox run in pending that the periodic check starts again.
    if (!engine.pool.startSandbox(sandboxRun.id)) {
      // A run that never started leaves no row; a pending one would be reaped as a lost run.
      engine.store.deleteSandboxRun(sandboxRun.id);
      instance.sandboxRunId = null;
      return ['lr_pending'];
    }
    return ['lr_working'];
  } catch (error) {
    // The write failed, so nothing was started and staying here is correct;
    // the periodic check retries.
    return ['lr_pending', asError(error)];
  }
}
