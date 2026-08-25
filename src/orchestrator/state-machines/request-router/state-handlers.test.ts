import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../../store/store.js';
import type { RequestRouter, RequestRouterState } from '../../../store/types.js';
import { FakeLocker, FakeSandboxPool } from '../../../testing/state-machines.js';
import { createTestStore } from '../../../testing/store.js';
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
      want: { state: 'rr_routing', startedRuns: 1 },
    },
    {
      name: 'When a sandbox run is still alive then should answer `rr_routing` without dispatching',
      arrange: (instance) => {
        instance.sandboxRunId = startRunFor(instance);
      },
      want: { state: 'rr_routing' },
    },
    {
      name: 'When the live run already finished then should dispatch again',
      arrange: (instance) => {
        const runId = startRunFor(instance);
        store.finishSandboxRun(runId, { runState: 'failed' });
        instance.sandboxRunId = runId;
      },
      want: { state: 'rr_routing', startedRuns: 1 },
    },
    {
      name: 'When the caps have no room then should answer `rr_pending` without recording a run',
      arrange: () => {
        pool.refuseRoom = true;
      },
      want: { state: 'rr_pending' },
    },
    {
      name: 'When the concurrency caps refuse the sandbox then should answer `rr_pending`',
      arrange: () => {
        pool.refuseToStart = true;
      },
      want: { state: 'rr_pending' },
    },
    {
      name: 'When the dispatch cannot be recorded then should answer `rr_pending` with the failure',
      arrange: () => store.db.exec('DROP TABLE sandbox_run'),
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
  };
}
