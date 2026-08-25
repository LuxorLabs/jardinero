import { recordWorkflowInstanceOpened } from '../execution.js';
import type { CreateRequestInput } from '../../../store/store.js';
import type { RequestRouter, SubjectType } from '../../../store/types.js';
import type { Lock } from '../execution.js';
import { runRequestRouterFSM, setState, UnsupportedStateError } from './engine.js';
import type { RequestRouterStateEngine } from './service.js';

// RoutingOutcome is what the routing agent answered. A request it could not place comes
// back with the questions to ask instead of a subject.
export interface RoutingOutcome {
  subjectType?: SubjectType;
  subjectExternalId?: string;
  repositoryId?: string;
  resolutionNote?: string;
}

interface TakenRequestRouter {
  instance: RequestRouter;
  lock: Lock;
}

// onRequestReceived is every inbound ask, from any source. The row is written even for
// an ask nobody will act on, so a discarded one is still visible.
export async function onRequestReceived(
  engine: RequestRouterStateEngine,
  input: CreateRequestInput,
): Promise<Error | undefined> {
  const created = engine.store.createRequest(input);
  recordWorkflowInstanceOpened(engine.store, 'request_router', created, {
    request_source: created.requestSource,
    requester_external_id: created.requesterExternalId,
    request_text: created.requestText,
    subject_type: created.subjectType,
    subject_external_id: created.subjectExternalId,
  });
  const lock = await engine.locker.acquire(requestRouterLockKey(created.id));
  if (!lock) return undefined;
  try {
    const instance = engine.store.getRequest(created.id);
    if (!instance) return undefined;
    switch (instance.workflowState) {
      case 'rr_pending':
        return runRequestRouterFSM(engine, instance);

      // Born resolved because the event carried its subject: no agent and no
      // cost, and the machine is already finished.
      case 'rr_resolved':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    lock.release();
  }
}

export async function onSandboxRunSucceeded(
  engine: RequestRouterStateEngine,
  sandboxRunId: string,
  outcome: RoutingOutcome,
): Promise<Error | undefined> {
  const taken = await takeRequestRouterBySandboxRun(engine, sandboxRunId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'rr_routing':
        instance.sandboxRunId = null;
        // No subject means the agent could not place the request, and the
        // questions it produced are the answer we give back.
        if (!outcome.subjectType || !outcome.subjectExternalId) {
          instance.resolutionNote = outcome.resolutionNote ?? 'no_subject_found';
          return setState(engine, instance, 'rr_unresolvable');
        }
        instance.subjectType = outcome.subjectType;
        instance.subjectExternalId = outcome.subjectExternalId;
        instance.repositoryId = outcome.repositoryId ?? instance.repositoryId;
        return setState(engine, instance, 'rr_resolved');

      default:
        // An outcome that arrives in any other state is stale.
        return undefined;
    }
  } finally {
    taken.lock.release();
  }
}

export async function onSandboxRunFailed(
  engine: RequestRouterStateEngine,
  sandboxRunId: string,
): Promise<Error | undefined> {
  const taken = await takeRequestRouterBySandboxRun(engine, sandboxRunId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'rr_routing':
        instance.sandboxRunId = null;
        instance.resolutionNote = 'routing_run_failed';
        return setState(engine, instance, 'rr_unresolvable');

      default:
        return undefined;
    }
  } finally {
    taken.lock.release();
  }
}

// onPeriodicCheck is one tick of the clock. The clock knows no cadences: each state
// decides whether enough time has passed to look again.
export async function onPeriodicCheck(
  engine: RequestRouterStateEngine,
  requestRouterId: string,
): Promise<Error | undefined> {
  const taken = await takeRequestRouterById(engine, requestRouterId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    const wait = engine.config.checkWaitMs[instance.workflowState];
    // A state left out of the map is never looked at, on purpose.
    if (wait === undefined) return undefined;
    if (Date.now() - (instance.lastStateCheckedAt ?? 0) < wait) return undefined;
    engine.store.markRequestChecked(instance.id);

    switch (instance.workflowState) {
      case 'rr_pending':
        // The dispatch never happened: the pool was full or paused, or whoever
        // held the work lock died holding it.
        return runRequestRouterFSM(engine, instance);

      case 'rr_routing':
        return processSandboxRunWhileRouting(engine, instance);

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onSystemRecovery(
  engine: RequestRouterStateEngine,
  requestRouterId: string,
): Promise<Error | undefined> {
  const taken = await takeRequestRouterById(engine, requestRouterId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'rr_pending':
        return runRequestRouterFSM(engine, instance);

      case 'rr_routing':
        return processSandboxRunWhileRouting(engine, instance);

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

// processSandboxRunWhileRouting finds out what became of the routing run. It may have
// finished without anyone telling us, or died with the process.
function processSandboxRunWhileRouting(
  engine: RequestRouterStateEngine,
  instance: RequestRouter,
): Error | undefined {
  const sandboxRun = instance.sandboxRunId
    ? engine.store.getSandboxRun(instance.sandboxRunId)
    : undefined;

  switch (sandboxRun?.runState) {
    case 'pending':
    case 'running':
      // The row outlives a process crash and the pool does not, so the pool is
      // the only thing that knows whether the sandbox is still alive.
      if (engine.pool.isExecuting(sandboxRun.id)) return undefined;
      engine.store.finishSandboxRun(sandboxRun.id, { runState: 'orphaned' });
      instance.sandboxRunId = null;
      // Routing is cheap and reads nothing it wrote, so asking again beats
      // answering a person with a question we could still resolve.
      return setStateAndRun(engine, instance, 'rr_pending');

    case 'succeeded':
      // The pool closes the run row before it hands the outcome over, so a run it still
      // holds is one whose outcome is on its way.
      if (engine.pool.isExecuting(sandboxRun.id)) return undefined;
      // Whoever reports the outcome carries the subject, and this path only
      // exists because nobody did.
      instance.sandboxRunId = null;
      instance.resolutionNote = 'routing_outcome_lost';
      return setState(engine, instance, 'rr_unresolvable');

    default:
      instance.sandboxRunId = null;
      instance.resolutionNote = 'routing_run_failed';
      return setState(engine, instance, 'rr_unresolvable');
  }
}

function setStateAndRun(
  engine: RequestRouterStateEngine,
  instance: RequestRouter,
  state: RequestRouter['workflowState'],
): Error | undefined {
  const writeError = setState(engine, instance, state);
  if (writeError) return writeError;
  return runRequestRouterFSM(engine, instance);
}

async function takeRequestRouterById(
  engine: RequestRouterStateEngine,
  requestRouterId: string,
): Promise<TakenRequestRouter | undefined> {
  const known = engine.store.getRequest(requestRouterId);
  if (!known) return undefined;
  const lock = await engine.locker.acquire(requestRouterLockKey(requestRouterId));
  if (!lock) return undefined;
  // Read again under the lock: whoever held it before may have moved the state.
  const instance = engine.store.getRequest(requestRouterId);
  if (!instance) {
    lock.release();
    return undefined;
  }
  return { instance, lock };
}

async function takeRequestRouterBySandboxRun(
  engine: RequestRouterStateEngine,
  sandboxRunId: string,
): Promise<TakenRequestRouter | undefined> {
  const sandboxRun = engine.store.getSandboxRun(sandboxRunId);
  if (sandboxRun?.workflowType !== 'request_router') return undefined;
  const taken = await takeRequestRouterById(engine, sandboxRun.workflowInstanceId);
  if (!taken) return undefined;
  // An outcome for a sandbox run the instance is no longer waiting on is stale.
  if (taken.instance.sandboxRunId !== sandboxRunId) {
    taken.lock.release();
    return undefined;
  }
  return taken;
}

// requestRouterLockKey is taken by every entry point, so two events for one request are
// handled one after the other.
function requestRouterLockKey(requestRouterId: string): string {
  return `request_router:${requestRouterId}`;
}
