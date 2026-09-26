import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../../store/store.js';
import type { LogReviewer, LogReviewerState, SandboxRunState } from '../../../store/types.js';
import { FakeLocker, FakeSandboxPool } from '../../../testing/state-machines.js';
import { createTestStore, refuseSandboxRunInserts } from '../../../testing/store.js';
import { LogReviewerStateEngine } from './service.js';
import { handleStateLrPending } from './state-handlers.js';

const MAX_ITERATIONS = 2;

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
    maxIterations: MAX_ITERATIONS,
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
      want: { state: 'lr_working', startedRuns: 1, runStates: ['pending'] },
    },
    {
      // Re-entering with a live run is what makes calling the handler twice
      // harmless after a crash between the commit and the enqueue.
      name: 'When a sandbox run is still alive then should answer `lr_working` without dispatching',
      arrange: (instance) => {
        instance.sandboxRunId = startRunFor(instance);
      },
      want: { state: 'lr_working', runStates: ['pending'] },
    },
    {
      name: 'When the live run already finished then should dispatch again',
      arrange: (instance) => {
        const runId = startRunFor(instance);
        store.finishSandboxRun(runId, { runState: 'failed' });
        instance.sandboxRunId = runId;
      },
      want: { state: 'lr_working', startedRuns: 1, runStates: ['failed', 'pending'] },
    },
    {
      name: 'When the caps have no room then should answer `lr_pending` without recording a run',
      arrange: () => {
        pool.refuseRoom = true;
      },
      want: { state: 'lr_pending' },
    },
    {
      name: 'When the lost runs exceed the budget then should answer `lr_failed` without dispatching',
      arrange: (instance) => loseRuns(instance, MAX_ITERATIONS + 1),
      want: { state: 'lr_failed', runStates: ['failed', 'failed', 'failed'] },
    },
    {
      name: 'When the lost runs are within the budget then should dispatch again',
      arrange: (instance) => loseRuns(instance, MAX_ITERATIONS),
      want: { state: 'lr_working', startedRuns: 1, runStates: ['failed', 'failed', 'pending'] },
    },
    {
      name: 'When the pool refuses the sandbox then should answer `lr_pending` without keeping a run',
      arrange: () => {
        pool.refuseToStart = true;
      },
      want: { state: 'lr_pending' },
    },
    {
      name: 'When the dispatch cannot be recorded then should answer `lr_pending` with the failure',
      arrange: () => refuseSandboxRunInserts(store),
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
      assert.equal(instance.sandboxRunId, store.listSandboxRuns(10, 'pending')[0]?.id ?? null);
      assert.deepEqual(
        store
          .listSandboxRuns(10)
          .map((run) => run.runState)
          .sort(),
        c.want.runStates ?? [],
      );
    });
  }
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

function loseRuns(instance: LogReviewer, count: number): void {
  for (let index = 0; index < count; index += 1) {
    store.finishSandboxRun(startRunFor(instance), { runState: 'failed' });
  }
}

interface PendingCase {
  name: string;
  arrange?: (instance: LogReviewer) => void;
  want: {
    state: LogReviewerState;
    startedRuns?: number;
    errorName?: string;
    runStates?: SandboxRunState[];
  };
}
