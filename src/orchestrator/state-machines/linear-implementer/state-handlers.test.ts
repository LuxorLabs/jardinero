import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../../store/store.js';
import type { LinearImplementer, LinearImplementerState } from '../../../store/types.js';
import { FakeGitHub, FakeLocker, FakeSandboxPool } from '../../../testing/state-machines.js';
import { createTestStore } from '../../../testing/store.js';
import { LinearImplementerStateEngine } from './service.js';
import {
  handleStateLiImplementing,
  handleStateLiPending,
  handleStateLiVerifying,
} from './state-handlers.js';

let store: Store;
let cleanup: () => void;
let pool: FakeSandboxPool;
let github: FakeGitHub;
let engine: LinearImplementerStateEngine;
let repositoryId: string;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  pool = new FakeSandboxPool();
  github = new FakeGitHub();
  repositoryId = store.upsertRepository('acme/web.app').id;
  engine = new LinearImplementerStateEngine(store, pool, github, new FakeLocker(), {
    maxIterations: 2,
    checkWaitMs: {},
  });
});

afterEach(() => {
  cleanup();
});

describe('handleStateLiPending', () => {
  const cases: PendingCase[] = [
    {
      // It owns no agent, so all it does is hand the ticket to the state that
      // does.
      name: 'When the ticket is pending then should hand it to `li_implementing` without dispatching',
      want: { state: 'li_implementing' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();

      const [nextState, error] = handleStateLiPending(engine, instance);

      assert.equal(error, undefined);
      assert.equal(nextState, c.want.state);
      assert.equal(pool.started.length, 0);
    });
  }
});

// The two states that own an agent dispatch it on the same terms, which is what
// keeps a second agent off the same ticket.
describe('LinearImplementer states that own an agent', () => {
  const cases: DispatchCase[] = [
    {
      name: 'When implementing has nothing in flight then should dispatch the implementer',
      handler: handleStateLiImplementing,
      want: { state: 'li_implementing', startedRuns: 1, agentName: 'LinearImplementer' },
    },
    {
      name: 'When verifying has nothing in flight then should dispatch the verifier',
      handler: handleStateLiVerifying,
      want: { state: 'li_verifying', startedRuns: 1, agentName: 'LinearVerifier' },
    },
    {
      name: 'When implementing already has a live run then should stay without dispatching',
      handler: handleStateLiImplementing,
      arrange: (instance) => {
        instance.sandboxRunId = startRunFor(instance);
      },
      want: { state: 'li_implementing' },
    },
    {
      name: 'When verifying already has a live run then should stay without dispatching',
      handler: handleStateLiVerifying,
      arrange: (instance) => {
        instance.sandboxRunId = startRunFor(instance);
      },
      want: { state: 'li_verifying' },
    },
    {
      name: 'When the live run already finished then should dispatch again',
      handler: handleStateLiImplementing,
      arrange: (instance) => {
        const runId = startRunFor(instance);
        store.finishSandboxRun(runId, { runState: 'failed' });
        instance.sandboxRunId = runId;
      },
      want: { state: 'li_implementing', startedRuns: 1, agentName: 'LinearImplementer' },
    },
    {
      name: 'When the caps have no room then should stay without recording a run',
      handler: handleStateLiImplementing,
      arrange: () => {
        pool.refuseRoom = true;
      },
      want: { state: 'li_implementing' },
    },
    {
      name: 'When the pool refuses the verifier then should stay verifying',
      handler: handleStateLiVerifying,
      arrange: () => {
        pool.refuseToStart = true;
      },
      want: { state: 'li_verifying' },
    },
    {
      name: 'When the dispatch cannot be recorded then should stay with the failure',
      handler: handleStateLiImplementing,
      arrange: () => store.db.exec('DROP TABLE sandbox_run'),
      want: { state: 'li_implementing', errorName: 'Error' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      c.arrange?.(instance);

      const [nextState, error] = c.handler(engine, instance);

      assert.equal(error?.constructor.name, c.want.errorName);
      assert.equal(nextState, c.want.state);
      assert.equal(pool.started.length, c.want.startedRuns ?? 0);
      assert.equal(
        pool.started[0] ? store.getSandboxRun(pool.started[0])?.agentName : undefined,
        c.want.agentName,
      );
    });
  }
});

function openInstance(): LinearImplementer {
  return store.openLinearImplementer({
    repositoryId,
    linearIssueId: 'iss-1',
    linearIssueIdentifier: 'JAR-58',
  });
}

function startRunFor(instance: LinearImplementer): string {
  return store.startSandboxRun({
    agentName: 'LinearImplementer',
    workflowType: 'linear_implementer',
    workflowInstanceId: instance.id,
  }).id;
}

interface PendingCase {
  name: string;
  want: { state: LinearImplementerState };
}

interface DispatchCase {
  name: string;
  handler: (
    engine: LinearImplementerStateEngine,
    instance: LinearImplementer,
  ) => [LinearImplementerState, Error?];
  arrange?: (instance: LinearImplementer) => void;
  want: {
    state: LinearImplementerState;
    startedRuns?: number;
    agentName?: string;
    errorName?: string;
  };
}
