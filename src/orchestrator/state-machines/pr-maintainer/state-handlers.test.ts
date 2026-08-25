import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../../store/store.js';
import type { PrMaintainer, PrMaintainerState } from '../../../store/types.js';
import { FakeGitHub, FakeLocker, FakeSandboxPool } from '../../../testing/state-machines.js';
import { createTestStore } from '../../../testing/store.js';
import { PrMaintainerStateEngine } from './service.js';
import { handleStatePrmPending, handleStatePrmWaiting } from './state-handlers.js';

const MAX_ATTEMPTS = 2;
const MAX_REPLIES_PER_THREAD = 2;

let store: Store;
let cleanup: () => void;
let pool: FakeSandboxPool;
let locker: FakeLocker;
let engine: PrMaintainerStateEngine;
let repositoryId: string;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  pool = new FakeSandboxPool();
  locker = new FakeLocker();
  repositoryId = store.upsertRepository('acme/web.app').id;
  engine = new PrMaintainerStateEngine(store, pool, new FakeGitHub(), locker, {
    maxAttempts: MAX_ATTEMPTS,
    maxRepliesPerThread: MAX_REPLIES_PER_THREAD,
    agentPullRequest: { branchPrefix: 'agent/' },
    checkWaitMs: {},
  });
});

afterEach(() => {
  cleanup();
});

describe('handleStatePrmPending', () => {
  const cases: PendingCase[] = [
    {
      name: 'When nothing is in flight then should dispatch and answer `prm_working`',
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1 },
    },
    {
      // Re-entering with a live run is what makes calling the handler twice
      // harmless after a crash between the commit and the enqueue.
      name: 'When a sandbox run is still alive then should answer `prm_working` without dispatching',
      arrange: (instance) => {
        instance.sandboxRunId = startRunFor(instance);
      },
      want: { state: 'prm_working' },
    },
    {
      name: 'When the live run already finished then should dispatch again',
      arrange: (instance) => {
        const runId = startRunFor(instance);
        store.finishSandboxRun(runId, { runState: 'failed' });
        instance.sandboxRunId = runId;
      },
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1 },
    },
    {
      name: 'When the attempts are spent then should answer `prm_attempts_exhausted`',
      arrange: (instance) => {
        instance.attemptCount = MAX_ATTEMPTS;
      },
      want: {
        state: 'prm_attempts_exhausted',
        attemptCount: MAX_ATTEMPTS,
        needsHumanReason: 'attempts_exhausted',
      },
    },
    {
      name: 'When the caps have no room then should answer `prm_pending` without recording a run',
      arrange: () => {
        pool.refuseRoom = true;
      },
      want: { state: 'prm_pending' },
    },
    {
      name: 'When the concurrency caps refuse the sandbox then should answer `prm_pending`',
      arrange: () => {
        pool.refuseToStart = true;
      },
      want: { state: 'prm_pending', attemptCount: 1 },
    },
    {
      name: 'When the dispatch cannot be recorded then should answer `prm_pending` with the failure',
      arrange: () => store.db.exec('DROP TABLE sandbox_run'),
      want: { state: 'prm_pending', errorName: 'Error' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      c.arrange?.(instance);

      const [nextState, error] = handleStatePrmPending(engine, instance);

      assert.equal(error?.constructor.name, c.want.errorName);
      assert.equal(nextState, c.want.state);
      assert.equal(pool.started.length, c.want.startedRuns ?? 0);
      assert.equal(instance.attemptCount, c.want.attemptCount ?? 0);
      assert.equal(instance.needsHumanReason, c.want.needsHumanReason ?? null);
    });
  }
});

describe('handleStatePrmWaiting', () => {
  const cases: WaitingCase[] = [
    {
      // A comment that arrived while a run was in flight was recorded and nobody
      // took it, so it is picked up here instead of waiting for the next tick.
      name: 'When a request for this pull request is unconsumed then should answer `prm_pending`',
      arrange: () => seedRequest({ subjectExternalId: '4688', repositoryId }),
      want: { state: 'prm_pending' },
    },
    {
      name: 'When nothing is unconsumed then should answer `prm_waiting`',
      want: { state: 'prm_waiting' },
    },
    {
      name: 'When the unconsumed request was already taken then should answer `prm_waiting`',
      arrange: () => {
        const request = seedRequest({ subjectExternalId: '4688', repositoryId });
        store.markRequestConsumed(request, 'pr_maintainer', 'instance-1', repositoryId);
      },
      want: { state: 'prm_waiting' },
    },
    {
      name: 'When the unconsumed request is for another pull request then should answer `prm_waiting`',
      arrange: () => seedRequest({ subjectExternalId: '4691', repositoryId }),
      want: { state: 'prm_waiting' },
    },
    {
      // A pull request number only identifies a pull request inside its
      // repository, so the same number elsewhere must not wake this one.
      name: 'When the unconsumed request belongs to another repository then should answer `prm_waiting`',
      arrange: () =>
        seedRequest({
          subjectExternalId: '4688',
          repositoryId: store.upsertRepository('acme/webapp').id,
        }),
      want: { state: 'prm_waiting' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      c.arrange?.();

      const [nextState, error] = handleStatePrmWaiting(engine, instance);

      assert.equal(error, undefined);
      assert.equal(nextState, c.want.state);
    });
  }
});

function openInstance(): PrMaintainer {
  return store.openPrMaintainer({ repositoryId, pullRequestNumber: 4688 });
}

function seedRequest(fields: { subjectExternalId: string; repositoryId: string }): string {
  return store.createRequest({
    requestSource: 'github',
    subjectType: 'pull_request',
    subjectExternalId: fields.subjectExternalId,
    repositoryId: fields.repositoryId,
  }).id;
}

function startRunFor(instance: PrMaintainer): string {
  return store.startSandboxRun({
    agentName: 'PrMaintainer',
    workflowType: 'pr_maintainer',
    workflowInstanceId: instance.id,
  }).id;
}

interface PendingCase {
  name: string;
  arrange?: (instance: PrMaintainer) => void;
  want: {
    state: PrMaintainerState;
    startedRuns?: number;
    attemptCount?: number;
    needsHumanReason?: string;
    errorName?: string;
  };
}

interface WaitingCase {
  name: string;
  arrange?: () => void;
  want: { state: PrMaintainerState };
}
