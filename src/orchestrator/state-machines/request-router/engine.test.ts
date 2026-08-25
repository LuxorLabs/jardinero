import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../../store/store.js';
import type { RequestRouter, RequestRouterState } from '../../../store/types.js';
import {
  FakeLocker,
  FakeSandboxPool,
  type RecordingAnnouncer,
  createRecordingAnnouncer,
} from '../../../testing/state-machines.js';
import { createTestStore } from '../../../testing/store.js';
import { runRequestRouterFSM, setState } from './engine.js';
import { RequestRouterStateEngine } from './service.js';

let store: Store;
let cleanup: () => void;
let pool: FakeSandboxPool;
let engine: RequestRouterStateEngine;
let announcer: RecordingAnnouncer;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  pool = new FakeSandboxPool();
  announcer = createRecordingAnnouncer();
  engine = new RequestRouterStateEngine(
    store,
    pool,
    new FakeLocker(),
    { checkWaitMs: {} },
    announcer,
  );
});

afterEach(() => {
  cleanup();
});

describe('runRequestRouterFSM', () => {
  const cases: EngineCase[] = [
    {
      name: 'When there is only free text then should dispatch and settle in `rr_routing`',
      from: 'rr_pending',
      want: { state: 'rr_routing', startedRuns: 1 },
    },
    {
      name: 'When the subject is already known then should settle in `rr_resolved`',
      from: 'rr_pending',
      arrange: (instance) => {
        instance.subjectType = 'pull_request';
        instance.subjectExternalId = '4688';
      },
      want: { state: 'rr_resolved' },
    },
    {
      name: 'When the router agent is running then should finish the loop untouched',
      from: 'rr_routing',
      want: { state: 'rr_routing' },
    },
    {
      name: 'When the request resolved then should finish the loop untouched',
      from: 'rr_resolved',
      want: { state: 'rr_resolved' },
    },
    {
      name: 'When the request could not be placed then should finish the loop untouched',
      from: 'rr_unresolvable',
      want: { state: 'rr_unresolvable' },
    },
    {
      name: 'When the state is not one of the machine then should return an unsupported state error',
      from: 'rr_pending',
      arrange: (instance) => {
        instance.workflowState = 'nonsense' as RequestRouterState;
      },
      want: { state: 'nonsense' as RequestRouterState, errorName: 'UnsupportedStateError' },
    },
    {
      name: 'When the dispatch cannot be recorded then should report it and stay pending',
      from: 'rr_pending',
      arrange: () => store.db.exec('DROP TABLE sandbox_run'),
      want: { state: 'rr_pending', errorName: 'Error' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      setState(engine, instance, c.from);
      c.arrange?.(instance);

      const error = runRequestRouterFSM(engine, instance);

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
      nextState: 'rr_routing',
      want: { storedState: 'rr_routing', stampMoves: true },
    },
    {
      name: 'When the state is rewritten unchanged then should leave `stateChangedAt`',
      nextState: 'rr_pending',
      want: { storedState: 'rr_pending', stampMoves: false },
    },
    {
      name: 'When the instance carries what the agent found then should write it alongside the state',
      arrange: (instance) => {
        instance.subjectType = 'linear_issue';
        instance.subjectExternalId = 'JAR-58';
      },
      nextState: 'rr_resolved',
      want: {
        storedState: 'rr_resolved',
        stampMoves: true,
        subjectExternalId: 'JAR-58',
      },
    },
    {
      // A state the column refuses is the cheapest way to make the write fail.
      name: 'When the write fails then should return the failure instead of throwing',
      nextState: 'nonsense' as RequestRouterState,
      want: { storedState: 'rr_pending', stampMoves: false, errorName: 'Error' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      instance.stateChangedAt = 0;
      c.arrange?.(instance);

      const error = setState(engine, instance, c.nextState);

      const stored = store.getRequest(instance.id);
      assert.equal(error?.constructor.name, c.want.errorName);
      assert.equal(stored?.workflowState, c.want.storedState);
      assert.equal(stored?.subjectExternalId, c.want.subjectExternalId ?? null);
      assert.equal(instance.stateChangedAt > 0, c.want.stampMoves);
      assert.equal(
        store
          .listEventsForInstance('request_router', instance.id)
          .filter((event) => event.eventType === 'workflow.state_changed').length,
        c.want.stampMoves ? 1 : 0,
      );
    });
  }
});

function openInstance(): RequestRouter {
  return store.createRequest({ requestSource: 'discord', requestText: 'fix this' });
}

interface EngineCase {
  name: string;
  from: RequestRouterState;
  arrange?: (instance: RequestRouter) => void;
  want: { state: RequestRouterState; startedRuns?: number; errorName?: string };
}

interface SetStateCase {
  name: string;
  nextState: RequestRouterState;
  arrange?: (instance: RequestRouter) => void;
  want: {
    storedState: RequestRouterState;
    stampMoves: boolean;
    subjectExternalId?: string;
    errorName?: string;
  };
}

describe('The moments a request announces', () => {
  const cases: Array<{
    name: string;
    from: RequestRouterState;
    to: RequestRouterState;
    repositoryId?: string;
    wantMoments: string[];
  }> = [
    {
      name: 'When the request cannot be placed then should announce the questions',
      from: 'rr_routing',
      to: 'rr_unresolvable',
      repositoryId: 'seeded',
      wantMoments: ['requestUnresolvable'],
    },
    {
      // Without a repository there is no channel to answer in.
      name: 'When the request names no repository then should announce nothing',
      from: 'rr_routing',
      to: 'rr_unresolvable',
      wantMoments: [],
    },
    {
      // A placed request is handed over, and the machine that takes it does the talking.
      name: 'When the request is placed then should announce nothing',
      from: 'rr_routing',
      to: 'rr_resolved',
      repositoryId: 'seeded',
      wantMoments: [],
    },
    {
      name: 'When the state does not change then should announce nothing',
      from: 'rr_routing',
      to: 'rr_routing',
      repositoryId: 'seeded',
      wantMoments: [],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const instance = store.createRequest({
        requestSource: 'discord',
        requestText: 'fix it',
        repositoryId: testCase.repositoryId
          ? store.upsertRepository('acme/orchestrator').id
          : undefined,
      });
      store.setRequestState(instance.id, testCase.from);
      instance.workflowState = testCase.from;

      setState(engine, instance, testCase.to);

      assert.deepEqual(announcer.moments, testCase.wantMoments);
    });
  }
});
