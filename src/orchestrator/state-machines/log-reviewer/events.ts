import { nowMs } from '../../../platform/time.js';
import type { LogReviewer } from '../../../store/types.js';
import { consumeRequest, recordWorkflowInstanceOpened, type Lock } from '../execution.js';
import { runLogReviewerFSM, setState, UnsupportedStateError } from './engine.js';
import type { LogReviewerStateEngine } from './service.js';

export interface ScanTarget {
  repositoryId: string;
  serviceName?: string;
  environmentName?: string;
}

// ScanOutcome is what the scan reported: how many findings it produced.
export interface ScanOutcome {
  findingCount: number;
}

interface TakenLogReviewer {
  instance: LogReviewer;
  lock: Lock;
}

// onScheduledScan is the clock asking for a scan. Unlike the other machines this one
// opens a new instance per scan, because two scans of one target are two scans.
export async function onScheduledScan(
  engine: LogReviewerStateEngine,
  target: ScanTarget,
  requestRouterId?: string,
): Promise<Error | undefined> {
  // A scan of this target that has not ended yet already covers what this one
  // would read.
  if (
    engine.store.findOpenLogReviewerByTarget(
      target.repositoryId,
      target.serviceName,
      target.environmentName,
    )
  ) {
    return undefined;
  }

  // Every scan reads the same window back, so one that read it already covers what this one
  // would; a deploy asking again buys a sandbox and a duplicate finding. A scan that failed
  // read nothing, and its window is nobody else's to read.
  const previous = engine.store.findLatestLogReviewerByTarget(
    target.repositoryId,
    target.serviceName,
    target.environmentName,
  );
  const covered = previous?.workflowState === 'lr_done';
  const sinceMs = previous === undefined ? Number.POSITIVE_INFINITY : nowMs() - previous.createdAt;
  if (previous !== undefined && covered && sinceMs < engine.config.scanWindowMs) {
    engine.store.appendEvent({
      eventType: 'workflow.scan_debounced',
      workflowType: 'log_reviewer',
      workflowInstanceId: previous.id,
      repositoryId: target.repositoryId,
      metadata: {
        service_name: target.serviceName ?? null,
        environment_name: target.environmentName ?? null,
        minutes_since_last_scan: Math.floor(sinceMs / 60_000),
        window_minutes: Math.floor(engine.config.scanWindowMs / 60_000),
      },
    });
    // The scan that read the window is what answers this ask, so it stops being owed.
    consumeRequest(engine.store, 'log_reviewer', requestRouterId, previous);
    return undefined;
  }

  const instance = engine.store.openLogReviewer({
    repositoryId: target.repositoryId,
    serviceName: target.serviceName,
    environmentName: target.environmentName,
    requestRouterId,
  });
  recordWorkflowInstanceOpened(engine.store, 'log_reviewer', instance, {
    service_name: instance.serviceName,
    environment_name: instance.environmentName,
  });
  consumeRequest(engine.store, 'log_reviewer', requestRouterId, instance);
  const lock = await engine.locker.acquire(logReviewerLockKey(instance.id));
  if (!lock) return undefined;
  try {
    switch (instance.workflowState) {
      case 'lr_pending':
        return runLogReviewerFSM(engine, instance);

      case 'lr_working':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    lock.release();
  }
}

export async function onSandboxRunSucceeded(
  engine: LogReviewerStateEngine,
  sandboxRunId: string,
  outcome: ScanOutcome,
): Promise<Error | undefined> {
  const taken = await takeLogReviewerBySandboxRun(engine, sandboxRunId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'lr_working':
        instance.sandboxRunId = null;
        instance.findingCount = outcome.findingCount;
        return setState(engine, instance, 'lr_done');

      default:
        // An outcome that arrives in any other state is stale.
        return undefined;
    }
  } finally {
    taken.lock.release();
  }
}

export async function onSandboxRunFailed(
  engine: LogReviewerStateEngine,
  sandboxRunId: string,
): Promise<Error | undefined> {
  const taken = await takeLogReviewerBySandboxRun(engine, sandboxRunId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'lr_working':
        // There is nothing to remember about a failed scan: the next tick opens
        // a new instance and asks Grafana again.
        instance.sandboxRunId = null;
        return setState(engine, instance, 'lr_failed');

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
  engine: LogReviewerStateEngine,
  logReviewerId: string,
): Promise<Error | undefined> {
  const taken = await takeLogReviewerById(engine, logReviewerId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    const wait = engine.config.checkWaitMs[instance.workflowState];
    // A state left out of the map is never looked at, on purpose.
    if (wait === undefined) return undefined;
    if (Date.now() - (instance.lastStateCheckedAt ?? 0) < wait) return undefined;
    engine.store.markLogReviewerChecked(instance.id);

    switch (instance.workflowState) {
      case 'lr_pending':
        // The dispatch never happened: the pool was full or paused, or whoever
        // held the work lock died holding it.
        return runLogReviewerFSM(engine, instance);

      case 'lr_working':
        return processSandboxRunWhileWorking(engine, instance);

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onSystemRecovery(
  engine: LogReviewerStateEngine,
  logReviewerId: string,
): Promise<Error | undefined> {
  const taken = await takeLogReviewerById(engine, logReviewerId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'lr_pending':
        return runLogReviewerFSM(engine, instance);

      case 'lr_working':
        return processSandboxRunWhileWorking(engine, instance);

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

// processSandboxRunWhileWorking finds out what became of the run. It may have finished
// without anyone telling us, or died with the process, and each ends somewhere
// different.
function processSandboxRunWhileWorking(
  engine: LogReviewerStateEngine,
  instance: LogReviewer,
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
      return setState(engine, instance, 'lr_failed');

    case 'succeeded':
      // The pool closes the run row before it hands the outcome over, so a run it still
      // holds is one whose outcome is on its way.
      if (engine.pool.isExecuting(sandboxRun.id)) return undefined;
      // The count is unknown here: whoever reports the outcome carries it, and
      // this path only exists because nobody did.
      instance.sandboxRunId = null;
      return setState(engine, instance, 'lr_done');

    default:
      instance.sandboxRunId = null;
      return setState(engine, instance, 'lr_failed');
  }
}

async function takeLogReviewerById(
  engine: LogReviewerStateEngine,
  logReviewerId: string,
): Promise<TakenLogReviewer | undefined> {
  const known = engine.store.getLogReviewer(logReviewerId);
  if (!known) return undefined;
  const lock = await engine.locker.acquire(logReviewerLockKey(logReviewerId));
  if (!lock) return undefined;
  // Read again under the lock: whoever held it before may have moved the state.
  const instance = engine.store.getLogReviewer(logReviewerId);
  if (!instance) {
    lock.release();
    return undefined;
  }
  return { instance, lock };
}

async function takeLogReviewerBySandboxRun(
  engine: LogReviewerStateEngine,
  sandboxRunId: string,
): Promise<TakenLogReviewer | undefined> {
  const sandboxRun = engine.store.getSandboxRun(sandboxRunId);
  if (sandboxRun?.workflowType !== 'log_reviewer') return undefined;
  const taken = await takeLogReviewerById(engine, sandboxRun.workflowInstanceId);
  if (!taken) return undefined;
  // An outcome for a sandbox run the instance is no longer waiting on is stale.
  if (taken.instance.sandboxRunId !== sandboxRunId) {
    taken.lock.release();
    return undefined;
  }
  return taken;
}

// logReviewerLockKey is taken by every entry point, so two events for one scan are
// handled one after the other.
function logReviewerLockKey(logReviewerId: string): string {
  return `log_reviewer:${logReviewerId}`;
}
