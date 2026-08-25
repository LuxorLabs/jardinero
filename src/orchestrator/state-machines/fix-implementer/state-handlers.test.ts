import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../../store/store.js';
import type { FixImplementer, FixImplementerState } from '../../../store/types.js';
import { FakeGitHub, FakeLocker, FakeSandboxPool } from '../../../testing/state-machines.js';
import { createTestStore } from '../../../testing/store.js';
import { FixImplementerStateEngine } from './service.js';
import {
  handleStateFiImplementing,
  handleStateFiPending,
  handleStateFiVerifying,
} from './state-handlers.js';

let store: Store;
let cleanup: () => void;
let pool: FakeSandboxPool;
let engine: FixImplementerStateEngine;
let repositoryId: string;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  pool = new FakeSandboxPool();
  repositoryId = store.upsertRepository('acme/web.app').id;
  engine = new FixImplementerStateEngine(store, pool, new FakeGitHub(), new FakeLocker(), {
    maxIterations: 2,
    checkWaitMs: {},
  });
});

afterEach(() => {
  cleanup();
});

describe('handleStateFiPending', () => {
  const cases: HandlerCase[] = [
    {
      // It owns no agent, so all it does is hand the finding to the state that
      // does.
      name: 'When the finding is pending then should hand it to `fi_implementing` without dispatching',
      want: { state: 'fi_implementing' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();

      const [nextState, error] = handleStateFiPending(engine, instance);

      assert.equal(error, undefined);
      assert.equal(nextState, c.want.state);
      assert.equal(pool.started.length, 0);
    });
  }
});

describe('handleStateFiImplementing', () => {
  const cases: HandlerCase[] = [
    {
      name: 'When nothing is in flight then should dispatch and stay implementing',
      want: { state: 'fi_implementing', startedRuns: 1 },
    },
    {
      // Re-entering with a live run is what makes calling the handler twice
      // harmless after a crash between the commit and the enqueue.
      name: 'When a sandbox run is still alive then should stay without dispatching',
      arrange: (instance) => {
        instance.sandboxRunId = startRunFor(instance);
      },
      want: { state: 'fi_implementing' },
    },
    {
      name: 'When the live run already finished then should dispatch again',
      arrange: (instance) => {
        const runId = startRunFor(instance);
        store.finishSandboxRun(runId, { runState: 'failed' });
        instance.sandboxRunId = runId;
      },
      want: { state: 'fi_implementing', startedRuns: 1 },
    },
    {
      name: 'When the caps have no room then should answer `fi_implementing` without recording a run',
      arrange: () => {
        pool.refuseRoom = true;
      },
      want: { state: 'fi_implementing' },
    },
    {
      name: 'When the pool refuses the sandbox then should stay implementing',
      arrange: () => {
        pool.refuseToStart = true;
      },
      want: { state: 'fi_implementing' },
    },
    {
      name: 'When the runs of this pass keep dying then should ask a person',
      arrange: (instance) => {
        for (let lost = 0; lost <= 2; lost += 1) {
          store.finishSandboxRun(startRunFor(instance), { runState: 'failed' });
        }
      },
      want: { state: 'fi_needs_human', needsHumanReason: 'run_failed' },
    },
    {
      name: 'When the dispatch cannot be recorded then should stay with the failure',
      arrange: () => store.db.exec('DROP TABLE sandbox_run'),
      want: { state: 'fi_implementing', errorName: 'Error' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      c.arrange?.(instance);

      const [nextState, error] = handleStateFiImplementing(engine, instance);

      assert.equal(error?.constructor.name, c.want.errorName);
      assert.equal(nextState, c.want.state);
      assert.equal(instance.needsHumanReason, c.want.needsHumanReason ?? null);
      assert.equal(pool.started.length, c.want.startedRuns ?? 0);
    });
  }
});

describe('handleStateFiVerifying', () => {
  const cases: HandlerCase[] = [
    {
      // A green that proved nothing is worse than no green, so the instance has
      // to keep saying out loud that nothing was verified.
      name: 'When the state is traversed then should wait saying nothing was verified',
      want: { state: 'fi_verifying', verifierIssues: 'not_verified' },
    },
    {
      name: 'When a verdict was carried over then should clear it',
      arrange: (instance) => {
        instance.verifierVerdict = 'accept';
      },
      want: { state: 'fi_verifying', verifierIssues: 'not_verified' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      c.arrange?.(instance);

      const [nextState, error] = handleStateFiVerifying(engine, instance);

      assert.equal(error, undefined);
      assert.equal(nextState, c.want.state);
      assert.equal(instance.verifierIssues, c.want.verifierIssues ?? null);
      assert.equal(instance.verifierVerdict, null);
    });
  }
});

function openInstance(): FixImplementer {
  return store.openFixImplementer({ repositoryId, findingFingerprint: 'fp-1' });
}

function startRunFor(instance: FixImplementer): string {
  return store.startSandboxRun({
    agentName: 'FixImplementer',
    workflowType: 'fix_implementer',
    workflowInstanceId: instance.id,
  }).id;
}

interface HandlerCase {
  name: string;
  arrange?: (instance: FixImplementer) => void;
  want: {
    state: FixImplementerState;
    startedRuns?: number;
    verifierIssues?: string;
    needsHumanReason?: string;
    errorName?: string;
  };
}
