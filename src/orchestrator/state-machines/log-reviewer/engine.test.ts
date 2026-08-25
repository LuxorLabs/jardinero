import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../../store/store.js';
import type { LogReviewer, LogReviewerState } from '../../../store/types.js';
import { FakeLocker, FakeSandboxPool } from '../../../testing/state-machines.js';
import { createTestStore } from '../../../testing/store.js';
import { runLogReviewerFSM, setState } from './engine.js';
import { LogReviewerStateEngine } from './service.js';

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

describe('runLogReviewerFSM', () => {
  const cases: EngineCase[] = [
    {
      name: 'When the scan is pending then should dispatch and settle in `lr_working`',
      from: 'lr_pending',
      want: { state: 'lr_working', startedRuns: 1 },
    },
    {
      name: 'When the scan is running then should finish the loop untouched',
      from: 'lr_working',
      want: { state: 'lr_working' },
    },
    {
      name: 'When the scan produced its findings then should finish the loop untouched',
      from: 'lr_done',
      want: { state: 'lr_done' },
    },
    {
      name: 'When the scan failed then should finish the loop untouched',
      from: 'lr_failed',
      want: { state: 'lr_failed' },
    },
    {
      name: 'When the state is not one of the machine then should return an unsupported state error',
      from: 'lr_pending',
      arrange: (instance) => {
        instance.workflowState = 'nonsense' as LogReviewerState;
      },
      want: { state: 'nonsense' as LogReviewerState, errorName: 'UnsupportedStateError' },
    },
    {
      name: 'When the dispatch cannot be recorded then should report it and stay pending',
      from: 'lr_pending',
      arrange: () => store.db.exec('DROP TABLE sandbox_run'),
      want: { state: 'lr_pending', errorName: 'Error' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      setState(engine, instance, c.from);
      c.arrange?.(instance);

      const error = runLogReviewerFSM(engine, instance);

      assert.equal(error?.constructor.name, c.want.errorName);
      assert.equal(instance.workflowState, c.want.state);
      assert.equal(pool.started.length, c.want.startedRuns ?? 0);
    });
  }
});

describe('setState', () => {
  const cases: SetStateCase[] = [
    {
      name: 'When the state changes then should write it and move `stateChangedAt`',
      nextState: 'lr_working',
      want: { storedState: 'lr_working', stampMoves: true },
    },
    {
      name: 'When the state is rewritten unchanged then should leave `stateChangedAt`',
      nextState: 'lr_pending',
      want: { storedState: 'lr_pending', stampMoves: false },
    },
    {
      name: 'When the instance carries the finding count then should write it alongside the state',
      arrange: (instance) => {
        instance.findingCount = 5;
      },
      nextState: 'lr_done',
      want: { storedState: 'lr_done', stampMoves: true, findingCount: 5 },
    },
    {
      // A state the column refuses is the cheapest way to make the write fail.
      name: 'When the write fails then should return the failure instead of throwing',
      nextState: 'nonsense' as LogReviewerState,
      want: { storedState: 'lr_pending', stampMoves: false, errorName: 'Error' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      instance.stateChangedAt = 0;
      c.arrange?.(instance);

      const error = setState(engine, instance, c.nextState);

      const stored = store.getLogReviewer(instance.id);
      assert.equal(error?.constructor.name, c.want.errorName);
      assert.equal(stored?.workflowState, c.want.storedState);
      assert.equal(stored?.findingCount, c.want.findingCount ?? 0);
      assert.equal(instance.stateChangedAt > 0, c.want.stampMoves);
      assert.equal(
        store
          .listEventsForInstance('log_reviewer', instance.id)
          .filter((event) => event.eventType === 'workflow.state_changed').length,
        c.want.stampMoves ? 1 : 0,
      );
    });
  }
});

function openInstance(): LogReviewer {
  return store.openLogReviewer({ repositoryId, serviceName: 'api', environmentName: 'staging' });
}

interface EngineCase {
  name: string;
  from: LogReviewerState;
  arrange?: (instance: LogReviewer) => void;
  want: { state: LogReviewerState; startedRuns?: number; errorName?: string };
}

interface SetStateCase {
  name: string;
  nextState: LogReviewerState;
  arrange?: (instance: LogReviewer) => void;
  want: {
    storedState: LogReviewerState;
    stampMoves: boolean;
    findingCount?: number;
    errorName?: string;
  };
}
