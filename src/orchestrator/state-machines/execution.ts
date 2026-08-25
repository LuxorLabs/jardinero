import type { WorkConversation } from '../work-announcer.js';
import type { Store } from '../../store/store.js';
import type { WorkflowType } from '../../store/types.js';

export type { Lock, Locker } from '../../platform/locker.js';

// SandboxPool runs agents in sandboxes and rations how many run at once. It holds no
// queue: a run the caps refuse is refused, and its instance asks again on the next
// tick.
export interface SandboxPool {
  // Whether the caps allow one more sandbox for this workflow. A handler asks
  // first so a refusal costs no run row: an unstarted row would otherwise be
  // reaped as `orphaned` and read as a failure that never happened.
  hasRoomFor(workflowType: WorkflowType): boolean;
  // Starts the sandbox for an already created run and returns without waiting
  // for it; the outcome comes back later as its own event. False means the
  // concurrency caps refused it, so the instance stays where it is and the
  // periodic check asks again. There is no queue here: the queue is the
  // *_pending state.
  startSandbox(sandboxRunId: string): boolean;
  // Whether this process is executing the sandbox right now. The row can say
  // `running` and this can say no, which is exactly how a sandbox that died
  // with the process is told apart from one that is working.
  isExecuting(sandboxRunId: string): boolean;
  // Cuts the sandbox short, for when the subject reached a final state while an
  // agent was still working on it. There is no counterpart for the normal end:
  // the runner opens and closes the session itself.
  abort(sandboxRunId: string): void;
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function recordWorkflowStateChange(
  store: Pick<Store, 'appendEvent'>,
  workflowType: WorkflowType,
  instance: WorkflowInstance,
  toState: string,
): void {
  // Rewriting the same state is a machine saying it is still waiting, not a transition.
  if (instance.workflowState === toState) return;
  store.appendEvent({
    eventType: 'workflow.state_changed',
    workflowType,
    workflowInstanceId: instance.id,
    repositoryId: instance.repositoryId ?? undefined,
    fromState: instance.workflowState,
    toState,
  });
}

export function recordWorkflowInstanceOpened(
  store: Pick<Store, 'appendEvent'>,
  workflowType: WorkflowType,
  instance: WorkflowInstance,
  subject: Record<string, unknown>,
): void {
  store.appendEvent({
    eventType: 'workflow.instance_opened',
    workflowType,
    workflowInstanceId: instance.id,
    repositoryId: instance.repositoryId ?? undefined,
    metadata: { state: instance.workflowState, ...subject },
  });
}

export interface WorkflowInstance {
  id: string;
  workflowState: string;
  repositoryId?: string | null;
}

export function consumeRequest(
  store: Pick<Store, 'markRequestConsumed'>,
  workflowType: WorkflowType,
  requestRouterId: string | undefined,
  instance: { id: string; repositoryId: string },
): void {
  if (!requestRouterId) return;
  store.markRequestConsumed(requestRouterId, workflowType, instance.id, instance.repositoryId);
}

export const REPLY_CAP_REACHED_NOTE = 'reply_cap_reached';

// countConsecutiveLostRuns counts the runs of an instance that ended without an outcome
// since `sinceMs`, which a caller moves to grant a fresh budget.
export function countConsecutiveLostRuns(
  store: Pick<Store, 'listSandboxRunsForInstance'>,
  workflowType: WorkflowType,
  workflowInstanceId: string,
  sinceMs: number,
): number {
  const runs = store.listSandboxRunsForInstance(workflowType, workflowInstanceId);
  let lost = 0;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (!run || run.startedAt < sinceMs) break;
    if (run.runState === 'succeeded' || run.runState === 'skipped') break;
    if (run.runState === 'failed' || run.runState === 'orphaned' || run.runState === 'aborted') {
      lost += 1;
    }
  }
  return lost;
}

// retrieveWorkConversation reads who asked for a piece of work, and where, off the request
// that opened it, and answers the conversation the machines announce into.
export function retrieveWorkConversation(
  store: Pick<Store, 'getRequest'>,
  work: {
    key: string;
    name: string;
    repositoryId: string;
    workflowInstanceId: string;
    requestRouterId?: string | null;
  },
): WorkConversation {
  const request = work.requestRouterId ? store.getRequest(work.requestRouterId) : undefined;
  const externalId = request?.requesterExternalId;
  return {
    key: work.key,
    name: work.name,
    repositoryId: work.repositoryId,
    workflowInstanceId: work.workflowInstanceId,
    ...(request && externalId ? { askedBy: { source: request.requestSource, externalId } } : {}),
  };
}
