import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { loadConfig } from '../config.js';
import type { Store } from '../store/store.js';
import { createTestStore } from '../testing/store.js';
import { MockWorkerRunner } from './worker/mock-worker.js';
import { Orchestrator } from './orchestrator.js';

const CONFIG = loadConfig();

let store: Store;
let cleanup: () => void;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
});

afterEach(() => {
  cleanup();
});

describe('Orchestrator.start', () => {
  // Recovery runs before the clock, so a tick cannot find an instance the last
  // process left half way through a dispatch.
  test('When an instance was left open then should recover it before the clock ticks', async () => {
    const orchestrator = build();
    const repositoryId = store.upsertRepository('acme/web.app').id;
    const instance = store.openPrMaintainer({ repositoryId, pullRequestNumber: 4688 });

    await orchestrator.start();
    await orchestrator.stop();

    // prm_pending owes a dispatch, and recovery is what asks for it again.
    assert.equal(store.getPrMaintainer(instance.id)?.workflowState, 'prm_working');
    assert.equal(store.listSandboxRunsForInstance('pr_maintainer', instance.id).length, 1);
  });

  test('When nothing was left open then should start the clock anyway', async () => {
    const orchestrator = build();

    await orchestrator.start();
    await orchestrator.stop();

    assert.deepEqual(store.listOpenPrMaintainers(), []);
  });
});

describe('Orchestrator.stop', () => {
  test('When it stops then should leave no timer behind', async () => {
    const orchestrator = build();
    await orchestrator.start();

    await orchestrator.stop();

    // A live timer would keep the process up, so the test would not end.
    assert.ok(true);
  });
});

function build(): Orchestrator {
  return new Orchestrator({
    config: CONFIG,
    store,
    runner: new MockWorkerRunner(),
    github: {
      readPullRequest: () =>
        Promise.resolve({
          state: 'open' as const,
          headCommitSha: '',
          checksAreRed: false,
          hasUnresolvedReviewThreads: false,
        }),
      markReadyForReview: () => Promise.resolve(undefined),
      findOpenImplementationPullRequest: () => Promise.resolve(undefined),
      markCommentPickedUp: () => Promise.resolve(undefined),
    },
  });
}
