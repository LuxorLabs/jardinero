import type { RequestRouter, RequestRouterState } from '../../../store/types.js';
import { asError } from '../execution.js';
import type { RequestRouterStateEngine } from './service.js';

export type StateHandlerResult = [RequestRouterState, Error?];

// handleStateRrPending resolves a request that already carries its subject, and
// dispatches the routing agent for free text.
export function handleStateRrPending(
  engine: RequestRouterStateEngine,
  instance: RequestRouter,
): StateHandlerResult {
  if (instance.subjectType) return ['rr_resolved'];

  if (instance.sandboxRunId) {
    const existing = engine.store.getSandboxRun(instance.sandboxRunId);
    switch (existing?.runState) {
      // A live sandbox run means this was already done, which is what makes
      // calling the handler twice harmless.
      case 'pending':
      case 'running':
        return ['rr_routing'];
    }
  }

  // Creating the sandbox run, taking the lock and recording it on the instance
  // happen in one transaction, so a crash in the middle leaves no half-built
  // work.
  // Asked before the row exists, so a full pool costs nothing to reap.
  if (!engine.pool.hasRoomFor('request_router')) return ['rr_pending'];

  try {
    const sandboxRun = engine.store.startSandboxRun({
      agentName: 'RequestRouter',
      workflowType: 'request_router',
      workflowInstanceId: instance.id,
    });
    instance.sandboxRunId = sandboxRun.id;
    // The pool is in memory, so a crash between the row and this line leaves a
    // sandbox run in pending that the periodic check starts again.
    if (!engine.pool.startSandbox(sandboxRun.id)) {
      // The row is released with the pointer: a run left pending is reaped as
      // orphaned later, and that reads as a run that failed instead of one that
      // never started.
      engine.store.finishSandboxRun(sandboxRun.id, { runState: 'skipped' });
      instance.sandboxRunId = null;
      return ['rr_pending'];
    }
    return ['rr_routing'];
  } catch (error) {
    // The write failed, so nothing was started and staying here is correct;
    // the periodic check retries.
    return ['rr_pending', asError(error)];
  }
}
