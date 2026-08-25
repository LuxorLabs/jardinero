import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../../store/store.js';
import type { LogReviewer, LogReviewerState } from '../../../store/types.js';
import { FakeLocker, FakeSandboxPool } from '../../../testing/state-machines.js';
import { createTestStore } from '../../../testing/store.js';
import { LogReviewerStateEngine } from './service.js';
import { handleStateLrPending } from './state-handlers.js';

let store: Store;
let cleanup: () => void;
let pool: FakeSandboxPool;
let engine: LogReviewerStateEngine;
let repositoryId: string;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  pool = new FakeSandboxPool();
  repositoryId = store.upsertRepository('acme/web.app').id;
  engine = new LogReviewerStateEngine(store, pool, new FakeLocker(), {
    scanWindowMs: 0,
    checkWaitMs: {},
  });
});

afterEach(() => {
  cleanup();
});

describe('handleStateLrPending', () => {
  const cases: PendingCase[] = [
    {
      name: 'When nothing is in flight then should dispatch and answer `lr_working`',
      want: { state: 'lr_working', startedRuns: 1 },
    },
    {
      // Re-entering with a live run is what makes calling the handler twice
      // harmless after a crash between the commit and the enqueue.
      name: 'When a sandbox run is still alive then should answer `lr_working` without dispatching',
      arrange: (instance) => {
        instance.sandboxRunId = startRunFor(instance);
      },
      want: { state: 'lr_working' },
    },
    {
      name: 'When the live run already finished then should dispatch again',
      arrange: (instance) => {
        const runId = startRunFor(instance);
        store.finishSandboxRun(runId, { runState: 'failed' });
        instance.sandboxRunId = runId;
      },
      want: { state: 'lr_working', startedRuns: 1 },
    },
    {
      name: 'When the caps have no room then should answer `lr_pending` without recording a run',
      arrange: () => {
        pool.refuseRoom = true;
      },
      want: { state: 'lr_pending' },
    },
    {
      name: 'When the concurrency caps refuse the sandbox then should answer `lr_pending`',
      arrange: () => {
        pool.refuseToStart = true;
      },
      want: { state: 'lr_pending' },
    },
    {
      name: 'When the dispatch cannot be recorded then should answer `lr_pending` with the failure',
      arrange: () => store.db.exec('DROP TABLE sandbox_run'),
      want: { state: 'lr_pending', errorName: 'Error' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      c.arrange?.(instance);

      const [nextState, error] = handleStateLrPending(engine, instance);

      assert.equal(error?.constructor.name, c.want.errorName);
      assert.equal(nextState, c.want.state);
      assert.equal(pool.started.length, c.want.startedRuns ?? 0);
    });
  }

  // A run left pending would be reaped as orphaned and take the scan to lr_failed.
  test('When the pool refuses the sandbox then should release the run it recorded', () => {
    const instance = openInstance();
    pool.refuseToStart = true;

    handleStateLrPending(engine, instance);

    assert.equal(instance.sandboxRunId, null);
    assert.deepEqual(
      store.listSandboxRuns(10).map((run) => run.runState),
      ['skipped'],
    );
  });

  test('When the caps have no room then should create no sandbox run', () => {
    const instance = openInstance();
    pool.refuseRoom = true;

    handleStateLrPending(engine, instance);

    assert.deepEqual(store.listSandboxRuns(10), []);
    assert.equal(instance.sandboxRunId, null);
  });
});

function openInstance(): LogReviewer {
  return store.openLogReviewer({ repositoryId, serviceName: 'api', environmentName: 'staging' });
}

function startRunFor(instance: LogReviewer): string {
  return store.startSandboxRun({
    agentName: 'LogReviewer',
    workflowType: 'log_reviewer',
    workflowInstanceId: instance.id,
  }).id;
}

interface PendingCase {
  name: string;
  arrange?: (instance: LogReviewer) => void;
  want: {
    state: LogReviewerState;
    startedRuns?: number;
    errorName?: string;
  };
}
