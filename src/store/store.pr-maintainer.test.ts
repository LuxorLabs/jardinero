import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from './store.js';
import { PR_MAINTAINER_TERMINAL_STATES } from './types.js';
import type { PrMaintainer, PrMaintainerState } from './types.js';
import { type StoreFixture, createTestStore } from '../testing/store.js';

const OPEN_STATES: PrMaintainerState[] = [
  'prm_pending',
  'prm_working',
  'prm_waiting',
  'prm_attempts_exhausted',
];

let fixture: StoreFixture;
let store: Store;
let repositoryId: string;

beforeEach(() => {
  fixture = createTestStore();
  store = fixture.store;
  repositoryId = store.upsertRepository('acme/orchestrator').id;
});

afterEach(() => {
  fixture.cleanup();
});

describe('Store.openPrMaintainer', () => {
  // Two webhooks arriving together must converge on one instance; the partial
  // unique index would reject the second open row anyway.
  const cases: Array<{ name: string; firstState: PrMaintainerState; wantSameRow: boolean }> = [
    ...OPEN_STATES.map((state) => ({
      name: `When the pull request is already \`${state}\` then should return that instance`,
      firstState: state,
      wantSameRow: true,
    })),
    ...PR_MAINTAINER_TERMINAL_STATES.map((state) => ({
      name: `When the previous instance is \`${state}\` then should open a new one`,
      firstState: state,
      wantSameRow: false,
    })),
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const first = open();
      store.setPrMaintainerState(first.id, testCase.firstState);

      const second = open();

      assert.equal(second.id === first.id, testCase.wantSameRow);
    });
  }

  test('When the pull request has no instance then should open one pending', () => {
    const instance = open();

    assert.equal(instance.workflowState, 'prm_pending');
    assert.equal(instance.repositoryId, repositoryId);
    assert.equal(instance.pullRequestNumber, 7);
    assert.equal(instance.attemptCount, 0);
    assert.equal(instance.lastActedCommitSha, null);
    assert.equal(instance.lastStateCheckedAt, null);
  });

  test('When the same number belongs to another repository then should open its own instance', () => {
    const otherRepositoryId = store.upsertRepository('acme/webapp').id;
    const ours = open();

    const theirs = store.openPrMaintainer({
      repositoryId: otherRepositoryId,
      pullRequestNumber: 7,
    });

    assert.notEqual(theirs.id, ours.id);
  });
});

describe('Store.getPrMaintainer', () => {
  const cases: Array<{ name: string; id(storedId: string): string; wantFound: boolean }> = [
    {
      name: 'When the id is known then should return the instance',
      id: (storedId) => storedId,
      wantFound: true,
    },
    {
      name: 'When the id is unknown then should return nothing',
      id: () => 'missing',
      wantFound: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const stored = open();

      const found = store.getPrMaintainer(testCase.id(stored.id));

      assert.deepEqual(found, testCase.wantFound ? stored : undefined);
    });
  }
});

describe('Store.findOpenPrMaintainer', () => {
  const cases: Array<{ name: string; state: PrMaintainerState; wantFound: boolean }> = [
    ...OPEN_STATES.map((state) => ({
      name: `When the instance is \`${state}\` then should return it`,
      state,
      wantFound: true,
    })),
    ...PR_MAINTAINER_TERMINAL_STATES.map((state) => ({
      name: `When the instance is \`${state}\` then should return nothing`,
      state,
      wantFound: false,
    })),
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const instance = open();
      store.setPrMaintainerState(instance.id, testCase.state);

      const found = store.findOpenPrMaintainer(repositoryId, 7);

      assert.equal(found?.id, testCase.wantFound ? instance.id : undefined);
    });
  }
});

describe('Store.findPrMaintainerByPullRequest', () => {
  const cases: Array<{ name: string; pullRequestNumber: number; wantFound: boolean }> = [
    {
      // A comment on a merged PR must be answered as merged, not treated as a new PR.
      name: 'When the instance ended then should still return it',
      pullRequestNumber: 7,
      wantFound: true,
    },
    {
      name: 'When the pull request was never seen then should return nothing',
      pullRequestNumber: 404,
      wantFound: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const instance = open();
      store.setPrMaintainerState(instance.id, 'prm_merged');

      const found = store.findPrMaintainerByPullRequest(repositoryId, testCase.pullRequestNumber);

      assert.equal(found?.id, testCase.wantFound ? instance.id : undefined);
      assert.equal(found?.workflowState, testCase.wantFound ? 'prm_merged' : undefined);
    });
  }

  test('When the pull request was worked twice then should return the newest instance', () => {
    const first = open();
    store.setPrMaintainerState(first.id, 'prm_closed');
    store.db.prepare('UPDATE pr_maintainer SET created_at = 1 WHERE id = ?').run(first.id);
    const second = open();

    assert.equal(store.findPrMaintainerByPullRequest(repositoryId, 7)?.id, second.id);
  });
});

describe('Store.setPrMaintainerState', () => {
  const cases: Array<{
    name: string;
    fields: Parameters<Store['setPrMaintainerState']>[2];
    want: Partial<PrMaintainer>;
  }> = [
    {
      name: 'When fields are given then should store them',
      fields: {
        sandboxRunId: 'run-1',
        lastActedCommitSha: 'abc123',
        needsHumanReason: 'blocked',
        attemptCount: 2,
      },
      want: {
        sandboxRunId: 'run-1',
        lastActedCommitSha: 'abc123',
        needsHumanReason: 'blocked',
        attemptCount: 2,
      },
    },
    {
      // The commit acted on and the attempt count belong to the pull request; the
      // run and the reason belong to one attempt and are dropped with it.
      name: 'When the transition says nothing then should keep the commit and count only',
      fields: {},
      want: {
        sandboxRunId: null,
        lastActedCommitSha: 'def456',
        needsHumanReason: null,
        attemptCount: 1,
      },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const instance = open();
      store.setPrMaintainerState(instance.id, 'prm_working', {
        sandboxRunId: 'run-0',
        lastActedCommitSha: 'def456',
        needsHumanReason: 'earlier',
        attemptCount: 1,
      });

      store.setPrMaintainerState(instance.id, 'prm_waiting', testCase.fields);

      const stored = store.getPrMaintainer(instance.id) as PrMaintainer;
      assert.equal(stored.workflowState, 'prm_waiting');
      for (const [field, value] of Object.entries(testCase.want)) {
        assert.equal(stored[field as keyof PrMaintainer], value, field);
      }
    });
  }

  const stateChangeCases: Array<{ name: string; next: PrMaintainerState; wantMoved: boolean }> = [
    {
      name: 'When the state changes then should move `state_changed_at`',
      next: 'prm_working',
      wantMoved: true,
    },
    {
      name: 'When the state is written again then should keep `state_changed_at`',
      next: 'prm_pending',
      wantMoved: false,
    },
  ];

  for (const testCase of stateChangeCases) {
    test(testCase.name, () => {
      const instance = open();
      store.db
        .prepare('UPDATE pr_maintainer SET state_changed_at = 1 WHERE id = ?')
        .run(instance.id);

      store.setPrMaintainerState(instance.id, testCase.next);

      assert.equal(store.getPrMaintainer(instance.id)?.stateChangedAt !== 1, testCase.wantMoved);
    });
  }
});

describe('Store.markPrMaintainerChecked', () => {
  test('When an instance is checked then should record when', () => {
    const instance = open();

    store.markPrMaintainerChecked(instance.id);

    assert.notEqual(store.getPrMaintainer(instance.id)?.lastStateCheckedAt, null);
  });
});

describe('Store.listPrMaintainersDue', () => {
  test('When an instance is waiting past its wait then should return it', () => {
    const instance = open();

    assert.deepEqual(idsOf(store.listPrMaintainersDue({ prm_pending: 1_000 })), [instance.id]);
  });
});

describe('Store.listOpenPrMaintainers', () => {
  test('When an instance ended then should return only the open ones', () => {
    const openInstance = open();
    const ended = open(8);
    store.setPrMaintainerState(ended.id, 'prm_merged');

    assert.deepEqual(idsOf(store.listOpenPrMaintainers()), [openInstance.id]);
  });
});

describe('Store.bumpThreadReply', () => {
  test('When the thread has no replies then should count the first one', () => {
    const instance = open();

    const thread = store.bumpThreadReply(instance.id, 'thread-1');

    assert.equal(thread.prMaintainerId, instance.id);
    assert.equal(thread.reviewThreadId, 'thread-1');
    assert.equal(thread.replyCount, 1);
  });

  test('When the thread was replied to before then should raise its count', () => {
    const instance = open();
    const first = store.bumpThreadReply(instance.id, 'thread-1');

    const second = store.bumpThreadReply(instance.id, 'thread-1');

    assert.equal(second.id, first.id);
    assert.equal(second.replyCount, 2);
  });

  test('When another thread is replied to then should count it apart', () => {
    const instance = open();
    store.bumpThreadReply(instance.id, 'thread-1');

    assert.equal(store.bumpThreadReply(instance.id, 'thread-2').replyCount, 1);
  });
});

function open(pullRequestNumber = 7): PrMaintainer {
  return store.openPrMaintainer({ repositoryId, pullRequestNumber });
}

function idsOf(instances: Array<{ id: string }>): string[] {
  return instances.map((instance) => instance.id);
}
