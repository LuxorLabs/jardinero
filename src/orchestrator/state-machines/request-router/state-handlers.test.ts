import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../../store/store.js';
import type { RequestRouter, RequestRouterState, SandboxRunState } from '../../../store/types.js';
import { FakeLocker, FakeSandboxPool } from '../../../testing/state-machines.js';
import { createTestStore, refuseSandboxRunInserts } from '../../../testing/store.js';
import { RequestRouterStateEngine } from './service.js';
import { handleStateRrPending } from './state-handlers.js';

let store: Store;
let cleanup: () => void;
let pool: FakeSandboxPool;
let engine: RequestRouterStateEngine;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  pool = new FakeSandboxPool();
  engine = new RequestRouterStateEngine(store, pool, new FakeLocker(), {
    checkWaitMs: {},
  });
});

afterEach(() => {
  cleanup();
});

describe('handleStateRrPending', () => {
  const cases: PendingCase[] = [
    {
      // Structured sources carry their subject, so they cost no agent and no
      // money: the state is traversed without stopping.
      name: 'When the event already carries its subject then should answer `rr_resolved`',
      arrange: (instance) => {
        instance.subjectType = 'pull_request';
        instance.subjectExternalId = '4688';
      },
      want: { state: 'rr_resolved' },
    },
    {
      name: 'When there is only free text then should dispatch the router agent',
      want: { state: 'rr_routing', startedRuns: 1, runStates: ['pending'] },
    },
    {
      name: 'When a sandbox run is still alive then should answer `rr_routing` without dispatching',
      arrange: (instance) => {
        instance.sandboxRunId = startRunFor(instance);
      },
      want: { state: 'rr_routing', runStates: ['pending'] },
    },
    {
      name: 'When the live run already finished then should dispatch again',
      arrange: (instance) => {
        const runId = startRunFor(instance);
        store.finishSandboxRun(runId, { runState: 'failed' });
        instance.sandboxRunId = runId;
      },
      want: { state: 'rr_routing', startedRuns: 1, runStates: ['failed', 'pending'] },
    },
    {
      name: 'When the caps have no room then should answer `rr_pending` without recording a run',
      arrange: () => {
        pool.refuseRoom = true;
      },
      want: { state: 'rr_pending' },
    },
    {
      name: 'When the pool refuses the sandbox then should answer `rr_pending` without keeping a run',
      arrange: () => {
        pool.refuseToStart = true;
      },
      want: { state: 'rr_pending' },
    },
    {
      name: 'When the dispatch cannot be recorded then should answer `rr_pending` with the failure',
      arrange: () => refuseSandboxRunInserts(store),
      want: { state: 'rr_pending', errorName: 'Error' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      c.arrange?.(instance);

      const [nextState, error] = handleStateRrPending(engine, instance);

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

function openInstance(): RequestRouter {
  return store.createRequest({ requestSource: 'discord', requestText: 'fix this' });
}

function startRunFor(instance: RequestRouter): string {
  return store.startSandboxRun({
    agentName: 'RequestRouter',
    workflowType: 'request_router',
    workflowInstanceId: instance.id,
  }).id;
}

interface PendingCase {
  name: string;
  arrange?: (instance: RequestRouter) => void;
  want: {
    state: RequestRouterState;
    startedRuns?: number;
    errorName?: string;
    runStates?: SandboxRunState[];
  };
}
