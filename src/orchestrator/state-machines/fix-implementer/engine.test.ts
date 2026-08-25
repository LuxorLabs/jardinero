import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../../store/store.js';
import type { FixImplementer, FixImplementerState } from '../../../store/types.js';
import {
  FakeGitHub,
  FakeLocker,
  FakeSandboxPool,
  type RecordingAnnouncer,
  createRecordingAnnouncer,
} from '../../../testing/state-machines.js';
import { createTestStore } from '../../../testing/store.js';
import { runFixImplementerFSM, setState } from './engine.js';
import { FixImplementerStateEngine } from './service.js';

let store: Store;
let cleanup: () => void;
let pool: FakeSandboxPool;
let engine: FixImplementerStateEngine;
let repositoryId: string;
let announcer: RecordingAnnouncer;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  pool = new FakeSandboxPool();
  repositoryId = store.upsertRepository('acme/web.app').id;
  announcer = createRecordingAnnouncer();
  engine = new FixImplementerStateEngine(
    store,
    pool,
    new FakeGitHub(),
    new FakeLocker(),
    { maxIterations: 2, checkWaitMs: {} },
    announcer,
  );
});

afterEach(() => {
  cleanup();
});

describe('runFixImplementerFSM', () => {
  const cases: EngineCase[] = [
    {
      // fi_pending owns no agent, so the loop carries it into the state that
      // does and dispatches there.
      name: 'When the finding is pending then should carry on and dispatch the implementer',
      from: 'fi_pending',
      want: { state: 'fi_implementing', startedRuns: 1 },
    },
    {
      name: 'When implementing has nothing in flight then should dispatch and stay',
      from: 'fi_implementing',
      want: { state: 'fi_implementing', startedRuns: 1 },
    },
    {
      // FixVerifier is wired and empty, so the loop only records that nothing was
      // verified: the release that leaves the state is the periodic check's.
      name: 'When verifying is entered then should stay saying nothing was verified',
      from: 'fi_verifying',
      want: { state: 'fi_verifying', verifierIssues: 'not_verified' },
    },
    {
      name: 'When a person has to look at it then should finish the loop untouched',
      from: 'fi_needs_human',
      want: { state: 'fi_needs_human' },
    },
    {
      name: 'When the pull request is being waited on then should finish the loop untouched',
      from: 'fi_waiting_pr',
      want: { state: 'fi_waiting_pr' },
    },
    {
      name: 'When the finding was discarded then should finish the loop untouched',
      from: 'fi_discarded',
      want: { state: 'fi_discarded' },
    },
    {
      name: 'When the fix merged then should finish the loop untouched',
      from: 'fi_done',
      want: { state: 'fi_done' },
    },
    {
      name: 'When the fix was closed unmerged then should finish the loop untouched',
      from: 'fi_abandoned',
      want: { state: 'fi_abandoned' },
    },
    {
      name: 'When the state is not one of the machine then should return an unsupported state error',
      from: 'fi_pending',
      arrange: (instance) => {
        instance.workflowState = 'nonsense' as FixImplementerState;
      },
      want: { state: 'nonsense' as FixImplementerState, errorName: 'UnsupportedStateError' },
    },
    {
      name: 'When the dispatch cannot be recorded then should report it and stay implementing',
      from: 'fi_implementing',
      arrange: () => store.db.exec('DROP TABLE sandbox_run'),
      want: { state: 'fi_implementing', errorName: 'Error' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      setState(engine, instance, c.from);
      c.arrange?.(instance);

      const error = runFixImplementerFSM(engine, instance);

      assert.equal(error?.constructor.name, c.want.errorName);
      assert.equal(instance.workflowState, c.want.state);
      assert.equal(pool.started.length, c.want.startedRuns ?? 0);
      assert.equal(instance.verifierIssues, c.want.verifierIssues ?? null);
    });
  }
});

describe('setState', () => {
  const cases: SetStateCase[] = [
    {
      name: 'When the state changes then should write it and move `stateChangedAt`',
      nextState: 'fi_implementing',
      want: { storedState: 'fi_implementing', stampMoves: true },
    },
    {
      name: 'When the state is rewritten unchanged then should leave `stateChangedAt`',
      nextState: 'fi_pending',
      want: { storedState: 'fi_pending', stampMoves: false },
    },
    {
      name: 'When the instance carries what the pass produced then should write it alongside the state',
      arrange: (instance) => {
        instance.pullRequestNumber = 77;
        instance.discardReason = 'false_positive';
      },
      nextState: 'fi_discarded',
      want: {
        storedState: 'fi_discarded',
        stampMoves: true,
        pullRequestNumber: 77,
        discardReason: 'false_positive',
      },
    },
    {
      // A state the column refuses is the cheapest way to make the write fail.
      name: 'When the write fails then should return the failure instead of throwing',
      nextState: 'nonsense' as FixImplementerState,
      want: { storedState: 'fi_pending', stampMoves: false, errorName: 'Error' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      instance.stateChangedAt = 0;
      c.arrange?.(instance);

      const error = setState(engine, instance, c.nextState);

      const stored = store.getFixImplementer(instance.id);
      assert.equal(error?.constructor.name, c.want.errorName);
      assert.equal(stored?.workflowState, c.want.storedState);
      assert.equal(stored?.pullRequestNumber, c.want.pullRequestNumber ?? null);
      assert.equal(stored?.discardReason, c.want.discardReason ?? null);
      assert.equal(instance.stateChangedAt > 0, c.want.stampMoves);
      assert.equal(
        store
          .listEventsForInstance('fix_implementer', instance.id)
          .filter((event) => event.eventType === 'workflow.state_changed').length,
        c.want.stampMoves ? 1 : 0,
      );
    });
  }
});

function openInstance(): FixImplementer {
  return store.openFixImplementer({ repositoryId, findingFingerprint: 'fp-1' });
}

interface EngineCase {
  name: string;
  from: FixImplementerState;
  arrange?: (instance: FixImplementer) => void;
  want: {
    state: FixImplementerState;
    startedRuns?: number;
    verifierIssues?: string;
    errorName?: string;
  };
}

interface SetStateCase {
  name: string;
  nextState: FixImplementerState;
  arrange?: (instance: FixImplementer) => void;
  want: {
    storedState: FixImplementerState;
    stampMoves: boolean;
    pullRequestNumber?: number;
    discardReason?: string;
    errorName?: string;
  };
}

describe('The moments a fix announces', () => {
  const cases: Array<{
    name: string;
    from: FixImplementerState;
    to: FixImplementerState;
    wantMoments: string[];
  }> = [
    {
      name: 'When it parks then should announce that',
      from: 'fi_implementing',
      to: 'fi_needs_human',
      wantMoments: ['fixParked'],
    },
    {
      // The maintainer adopts that pull request and announces it there.
      name: 'When the pull request is released then should announce nothing',
      from: 'fi_verifying',
      to: 'fi_waiting_pr',
      wantMoments: [],
    },
    {
      // A finding nobody has to act on is not worth telling anyone about.
      name: 'When there was nothing to fix then should announce nothing',
      from: 'fi_implementing',
      to: 'fi_discarded',
      wantMoments: [],
    },
    {
      name: 'When it only starts writing then should announce nothing',
      from: 'fi_pending',
      to: 'fi_implementing',
      wantMoments: [],
    },
    {
      name: 'When the state does not change then should announce nothing',
      from: 'fi_implementing',
      to: 'fi_implementing',
      wantMoments: [],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const instance = store.openFixImplementer({
        repositoryId,
        findingFingerprint: `fp-${testCase.from}-${testCase.to}`,
      });
      store.setFixImplementerState(instance.id, testCase.from);
      instance.workflowState = testCase.from;

      setState(engine, instance, testCase.to);

      assert.deepEqual(announcer.moments, testCase.wantMoments);
    });
  }
});
