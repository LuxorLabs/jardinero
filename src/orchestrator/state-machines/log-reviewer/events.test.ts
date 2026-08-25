import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../../store/store.js';
import type { LogReviewer, LogReviewerState, SandboxRunState } from '../../../store/types.js';
import { FakeLocker, FakeSandboxPool } from '../../../testing/state-machines.js';
import { createTestStore } from '../../../testing/store.js';
import { setState } from './engine.js';
import {
  onPeriodicCheck,
  onSandboxRunFailed,
  onSandboxRunSucceeded,
  onScheduledScan,
  onSystemRecovery,
} from './events.js';
import { LogReviewerStateEngine } from './service.js';

let store: Store;
let cleanup: () => void;
let pool: FakeSandboxPool;
let locker: FakeLocker;
let engine: LogReviewerStateEngine;
let repositoryId: string;

const SCAN_WINDOW_MS = 90 * 60_000;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  pool = new FakeSandboxPool();
  locker = new FakeLocker();
  repositoryId = store.upsertRepository('acme/web.app').id;
  engine = new LogReviewerStateEngine(store, pool, locker, {
    scanWindowMs: SCAN_WINDOW_MS,
    checkWaitMs: { lr_pending: 0, lr_working: 0 },
  });
});

afterEach(() => {
  cleanup();
});

describe('onScheduledScan', () => {
  const cases: ScanCase[] = [
    {
      name: 'When the tick arrives then should open a scan and dispatch it',
      want: { state: 'lr_working', startedRuns: 1, instances: 1 },
    },
    {
      // Two scans of one target are two scans, unlike every other workflow.
      name: 'When the window of the last scan is spent then should open a second scan',
      arrange: () => {
        const previous = store.openLogReviewer({ repositoryId });
        store.setLogReviewerState(previous.id, 'lr_done');
        backdate(previous.id, SCAN_WINDOW_MS + 60_000);
      },
      want: { state: 'lr_working', startedRuns: 1, instances: 2 },
    },
    {
      name: 'When the target was scanned inside the window then should read nothing again',
      arrange: () => {
        store.setLogReviewerState(store.openLogReviewer({ repositoryId }).id, 'lr_done');
      },
      want: { state: 'lr_done', instances: 1 },
    },
    {
      // The failed scan read nothing, so its window is still owed.
      name: 'When the last scan of the window failed then should open a second scan',
      arrange: () => {
        store.setLogReviewerState(store.openLogReviewer({ repositoryId }).id, 'lr_failed');
      },
      want: { state: 'lr_working', startedRuns: 1, instances: 2 },
    },
    {
      // Two scans of one target are two scans, but one after the other.
      name: 'When a scan of the same target has not ended then should not open a second one',
      arrange: async () => {
        await onScheduledScan(engine, { repositoryId });
        pool.started.length = 0;
      },
      want: { state: 'lr_working', instances: 1 },
      askStaysOpen: true,
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      await c.arrange?.();
      const ask = store.createRequest({
        requestSource: 'cron',
        repositoryId,
        subjectType: 'log_target',
      });

      const error = await onScheduledScan(engine, { repositoryId }, ask.id);

      assert.equal(error?.constructor.name, c.want.errorName);
      const instances = store.db
        .prepare('SELECT id, workflow_state FROM log_reviewer ORDER BY created_at ASC')
        .all() as Array<{ id: string; workflow_state: string }>;
      assert.equal(instances.length, c.want.instances);
      assert.equal(instances[instances.length - 1].workflow_state, c.want.state);
      assert.equal(pool.started.length, c.want.startedRuns ?? 0);
      assert.equal(
        store.getRequest(ask.id)?.workflowInstanceId,
        c.askStaysOpen ? null : instances[instances.length - 1].id,
      );
    });
  }
});

describe('onSandboxRunSucceeded', () => {
  const cases: RunOutcomeCase[] = [
    {
      name: 'When the scan finished then should record how many findings it produced',
      from: 'lr_working',
      want: { state: 'lr_done', findingCount: 5 },
    },
    {
      // An outcome for a run the instance is no longer waiting on is stale.
      name: 'When the instance moved on from that run then should ignore it',
      from: 'lr_working',
      detachRun: true,
      want: { state: 'lr_working' },
    },
    {
      name: 'When the instance is no longer working then should ignore it',
      from: 'lr_pending',
      want: { state: 'lr_pending' },
    },
    {
      name: 'When the run belongs to another workflow then should ignore it',
      from: 'lr_working',
      foreignRun: true,
      want: { state: 'lr_working' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = openInstanceIn(c.from);
      const runId = attachRun(instance, c);

      const error = await onSandboxRunSucceeded(engine, runId, { findingCount: 5 });

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onSandboxRunFailed', () => {
  const cases: RunOutcomeCase[] = [
    {
      // Nothing to remember about a failed scan: the next tick asks again.
      name: 'When the scan failed then should end the instance failed',
      from: 'lr_working',
      want: { state: 'lr_failed' },
    },
    {
      name: 'When the instance moved on from that run then should ignore it',
      from: 'lr_working',
      detachRun: true,
      want: { state: 'lr_working' },
    },
    {
      name: 'When the instance is no longer working then should ignore it',
      from: 'lr_pending',
      want: { state: 'lr_pending' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = openInstanceIn(c.from);
      const runId = attachRun(instance, c);

      const error = await onSandboxRunFailed(engine, runId);

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onPeriodicCheck', () => {
  const cases: PeriodicCase[] = [
    {
      name: 'When the state has no cadence then should never look at it',
      from: 'lr_done',
      want: { state: 'lr_done' },
    },
    {
      name: 'When the wait has not elapsed then should leave it alone',
      from: 'lr_pending',
      arrange: (instance) => {
        engine.config.checkWaitMs.lr_pending = 60_000;
        store.markLogReviewerChecked(instance.id);
      },
      want: { state: 'lr_pending' },
    },
    {
      name: 'When the dispatch is still owed then should retry it',
      from: 'lr_pending',
      want: { state: 'lr_working', startedRuns: 1 },
    },
    {
      name: 'When the run is still in the pool then should leave it working',
      from: 'lr_working',
      attachLiveRun: true,
      want: { state: 'lr_working' },
    },
    {
      name: 'When the run finished without telling us then should end it done',
      from: 'lr_working',
      attachFinishedRun: 'succeeded',
      want: { state: 'lr_done' },
    },
    {
      name: 'When the outcome is still on its way then should leave it working',
      from: 'lr_working',
      attachFinishedRun: 'succeeded',
      keepInPool: true,
      want: { state: 'lr_working' },
    },
    {
      name: 'When the run failed without telling us then should end it failed',
      from: 'lr_working',
      attachFinishedRun: 'failed',
      want: { state: 'lr_failed' },
    },
    {
      name: 'When the run died with the process then should end it failed',
      from: 'lr_working',
      attachLostRun: true,
      want: { state: 'lr_failed' },
    },
    {
      name: 'When the instance is unknown then should ignore it',
      unknownInstance: true,
      want: {},
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.unknownInstance ? undefined : openInstanceIn(c.from as LogReviewerState);
      if (instance) arrangePeriodic(instance, c);

      const error = await onPeriodicCheck(engine, instance?.id ?? 'missing');

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onSystemRecovery', () => {
  const cases: PeriodicCase[] = [
    {
      name: 'When the dispatch never happened then should dispatch it',
      from: 'lr_pending',
      want: { state: 'lr_working', startedRuns: 1 },
    },
    {
      name: 'When the run survived the restart then should leave it working',
      from: 'lr_working',
      attachLiveRun: true,
      want: { state: 'lr_working' },
    },
    {
      name: 'When the run died with the process then should end it failed',
      from: 'lr_working',
      attachLostRun: true,
      want: { state: 'lr_failed' },
    },
    {
      name: 'When the scan already finished then should return an unsupported state error',
      from: 'lr_done',
      want: { state: 'lr_done', errorName: 'UnsupportedStateError' },
    },
    {
      name: 'When the instance is unknown then should ignore it',
      unknownInstance: true,
      want: {},
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.unknownInstance ? undefined : openInstanceIn(c.from as LogReviewerState);
      if (instance) arrangePeriodic(instance, c);

      const error = await onSystemRecovery(engine, instance?.id ?? 'missing');

      assertOutcome(c.want, instance, error);
    });
  }
});

// Every entry point has to hand back the instance lock it took, whatever it
// decided, or a second event for the same scan would hang.
describe('LogReviewer entry points release the instance lock', () => {
  const cases: LockCase[] = [
    {
      name: 'When `onScheduledScan` runs then should release the lock',
      act: () => onScheduledScan(engine, { repositoryId }),
    },
    {
      name: 'When `onPeriodicCheck` runs then should release the lock',
      act: (id) => onPeriodicCheck(engine, id),
    },
    {
      name: 'When `onSystemRecovery` runs then should release the lock',
      act: (id) => onSystemRecovery(engine, id),
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = openInstanceIn('lr_pending');

      await c.act(instance.id);

      assert.equal(locker.isBalanced, true);
      assert.ok(locker.acquired.length > 0);
    });
  }
});

// Reaching for the column is what puts a scan outside the window without waiting for it.
function backdate(logReviewerId: string, byMs: number): void {
  store.db
    .prepare('UPDATE log_reviewer SET created_at = created_at - ? WHERE id = ?')
    .run(byMs, logReviewerId);
}

function openInstanceIn(state: LogReviewerState): LogReviewer {
  const instance = store.openLogReviewer({ repositoryId, serviceName: 'api' });
  setState(engine, instance, state);
  return instance;
}

function attachRun(instance: LogReviewer, c: RunOutcomeCase): string {
  const runId = store.startSandboxRun({
    agentName: 'LogReviewer',
    workflowType: c.foreignRun ? 'pr_maintainer' : 'log_reviewer',
    workflowInstanceId: instance.id,
  }).id;
  if (!c.detachRun && !c.foreignRun) {
    instance.sandboxRunId = runId;
    setState(engine, instance, instance.workflowState);
  }
  return runId;
}

function arrangePeriodic(instance: LogReviewer, c: PeriodicCase): void {
  if (c.attachLiveRun || c.attachLostRun || c.attachFinishedRun) {
    const runId = store.startSandboxRun({
      agentName: 'LogReviewer',
      workflowType: 'log_reviewer',
      workflowInstanceId: instance.id,
    }).id;
    instance.sandboxRunId = runId;
    setState(engine, instance, instance.workflowState);
    pool.startSandbox(runId);
    pool.started.length = 0;
    if (c.attachLostRun) pool.loseFromPool(runId);
    if (c.attachFinishedRun) {
      store.finishSandboxRun(runId, { runState: c.attachFinishedRun });
      if (!c.keepInPool) pool.loseFromPool(runId);
    }
  }
  c.arrange?.(instance);
}

function assertOutcome(
  want: Want,
  instance: LogReviewer | undefined,
  error: Error | undefined,
): void {
  assert.equal(error?.constructor.name, want.errorName);
  assert.equal(pool.started.length, want.startedRuns ?? 0);
  if (!instance) return;
  const stored = store.getLogReviewer(instance.id);
  assert.equal(stored?.workflowState, want.state);
  assert.equal(stored?.findingCount, want.findingCount ?? 0);
}

interface Want {
  state?: LogReviewerState;
  startedRuns?: number;
  findingCount?: number;
  errorName?: string;
}

interface ScanCase {
  name: string;
  arrange?: () => Promise<void> | void;
  want: Want & { instances: number };
  askStaysOpen?: boolean;
}

interface RunOutcomeCase {
  name: string;
  from: LogReviewerState;
  detachRun?: boolean;
  foreignRun?: boolean;
  want: Want;
}

interface PeriodicCase {
  name: string;
  from?: LogReviewerState;
  unknownInstance?: boolean;
  attachLiveRun?: boolean;
  attachLostRun?: boolean;
  attachFinishedRun?: Exclude<SandboxRunState, 'pending' | 'running'>;
  keepInPool?: boolean;
  arrange?: (instance: LogReviewer) => void;
  want: Want;
}

interface LockCase {
  name: string;
  act: (logReviewerId: string) => Promise<Error | undefined>;
}
