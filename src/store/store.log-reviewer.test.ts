import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from './store.js';
import { LOG_REVIEWER_TERMINAL_STATES } from './types.js';
import type { LogReviewer, LogReviewerState } from './types.js';
import { type StoreFixture, createTestStore } from '../testing/store.js';

const OPEN_STATES: LogReviewerState[] = ['lr_pending', 'lr_working'];

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

describe('Store.openLogReviewer', () => {
  test('When a scan is opened then should insert it pending', () => {
    const instance = open({ serviceName: 'api', environmentName: 'staging' });

    assert.equal(instance.workflowState, 'lr_pending');
    assert.equal(instance.repositoryId, repositoryId);
    assert.equal(instance.serviceName, 'api');
    assert.equal(instance.environmentName, 'staging');
    assert.equal(instance.findingCount, 0);
    assert.equal(instance.sandboxRunId, null);
    assert.equal(instance.lastStateCheckedAt, null);
  });

  // Two scans of one target are two scans, so there is nothing to converge on; the
  // partial unique index is what keeps them one after the other.
  test('When the previous scan of the target ended then should insert a second one', () => {
    const first = open({ serviceName: 'api' });
    store.setLogReviewerState(first.id, 'lr_done');

    const second = open({ serviceName: 'api' });

    assert.notEqual(second.id, first.id);
  });
});

describe('Store.getLogReviewer', () => {
  const cases: Array<{ name: string; id(storedId: string): string; wantFound: boolean }> = [
    {
      name: 'When the id is known then should return the scan',
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

      const found = store.getLogReviewer(testCase.id(stored.id));

      assert.deepEqual(found, testCase.wantFound ? stored : undefined);
    });
  }
});

describe('Store.setLogReviewerState', () => {
  const cases: Array<{
    name: string;
    fields: Parameters<Store['setLogReviewerState']>[2];
    wantFindingCount: number;
    wantSandboxRunId: string | null;
  }> = [
    {
      name: 'When the findings are counted then should store the count',
      fields: { findingCount: 3, sandboxRunId: 'run-1' },
      wantFindingCount: 3,
      wantSandboxRunId: 'run-1',
    },
    {
      // The count belongs to the scan, the run to the attempt: one is carried, the
      // other is dropped so the next attempt starts clean.
      name: 'When the transition says nothing then should keep the count and clear the run',
      fields: {},
      wantFindingCount: 2,
      wantSandboxRunId: null,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const instance = open();
      store.setLogReviewerState(instance.id, 'lr_working', {
        findingCount: 2,
        sandboxRunId: 'run-0',
      });

      store.setLogReviewerState(instance.id, 'lr_done', testCase.fields);

      const stored = store.getLogReviewer(instance.id);
      assert.equal(stored?.workflowState, 'lr_done');
      assert.equal(stored?.findingCount, testCase.wantFindingCount);
      assert.equal(stored?.sandboxRunId, testCase.wantSandboxRunId);
    });
  }

  const stateChangeCases: Array<{ name: string; next: LogReviewerState; wantMoved: boolean }> = [
    {
      name: 'When the state changes then should move `state_changed_at`',
      next: 'lr_working',
      wantMoved: true,
    },
    {
      name: 'When the state is written again then should keep `state_changed_at`',
      next: 'lr_pending',
      wantMoved: false,
    },
  ];

  for (const testCase of stateChangeCases) {
    test(testCase.name, () => {
      const instance = open();
      store.db
        .prepare('UPDATE log_reviewer SET state_changed_at = 1 WHERE id = ?')
        .run(instance.id);

      store.setLogReviewerState(instance.id, testCase.next);

      assert.equal(store.getLogReviewer(instance.id)?.stateChangedAt !== 1, testCase.wantMoved);
    });
  }
});

describe('Store.markLogReviewerChecked', () => {
  test('When a scan is checked then should record when', () => {
    const instance = open();

    store.markLogReviewerChecked(instance.id);

    assert.notEqual(store.getLogReviewer(instance.id)?.lastStateCheckedAt, null);
  });
});

describe('Store.listLogReviewersDue', () => {
  test('When a scan is waiting past its wait then should return it', () => {
    const instance = open();

    assert.deepEqual(idsOf(store.listLogReviewersDue({ lr_pending: 1_000 })), [instance.id]);
  });
});

describe('Store.findLatestLogReviewerByTarget', () => {
  const cases: Array<{ name: string; asked: string | undefined; wantFound: boolean }> = [
    {
      name: 'When the target matches then should return its last scan whatever its state',
      asked: 'api',
      wantFound: true,
    },
    {
      name: 'When no scan of the target exists then should return nothing',
      asked: 'worker',
      wantFound: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const older = open({ serviceName: 'api' });
      store.setLogReviewerState(older.id, 'lr_done');
      // Both scans open in the same millisecond, so the older one is moved back to make
      // "latest" mean something.
      store.db
        .prepare('UPDATE log_reviewer SET created_at = created_at - 60000 WHERE id = ?')
        .run(older.id);
      const latest = open({ serviceName: 'api' });
      store.setLogReviewerState(latest.id, 'lr_done');

      const found = store.findLatestLogReviewerByTarget(repositoryId, testCase.asked);

      assert.equal(found?.id, testCase.wantFound ? latest.id : undefined);
    });
  }
});

describe('Store.findOpenLogReviewerByTarget', () => {
  const cases: Array<{
    name: string;
    seeded: { serviceName?: string; environmentName?: string };
    asked: { serviceName?: string; environmentName?: string };
    wantFound: boolean;
  }> = [
    {
      name: 'When the target matches then should return the scan',
      seeded: { serviceName: 'api', environmentName: 'staging' },
      asked: { serviceName: 'api', environmentName: 'staging' },
      wantFound: true,
    },
    {
      // A repository-wide scan is a target of its own, so both sides being empty
      // has to match instead of comparing null with `=`.
      name: 'When the target has no service or environment then should return the scan',
      seeded: {},
      asked: {},
      wantFound: true,
    },
    {
      name: 'When the service differs then should return nothing',
      seeded: { serviceName: 'api' },
      asked: { serviceName: 'worker' },
      wantFound: false,
    },
    {
      name: 'When the environment differs then should return nothing',
      seeded: { serviceName: 'api', environmentName: 'staging' },
      asked: { serviceName: 'api', environmentName: 'production' },
      wantFound: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const instance = open(testCase.seeded);

      const found = store.findOpenLogReviewerByTarget(
        repositoryId,
        testCase.asked.serviceName,
        testCase.asked.environmentName,
      );

      assert.equal(found?.id, testCase.wantFound ? instance.id : undefined);
    });
  }

  for (const state of LOG_REVIEWER_TERMINAL_STATES) {
    test(`When the scan is \`${state}\` then should return nothing`, () => {
      const instance = open({ serviceName: 'api' });
      store.setLogReviewerState(instance.id, state);

      assert.equal(store.findOpenLogReviewerByTarget(repositoryId, 'api'), undefined);
    });
  }

  for (const state of OPEN_STATES) {
    test(`When the scan is \`${state}\` then should return it`, () => {
      const instance = open({ serviceName: 'api' });
      store.setLogReviewerState(instance.id, state);

      assert.equal(store.findOpenLogReviewerByTarget(repositoryId, 'api')?.id, instance.id);
    });
  }
});

describe('Store.listOpenLogReviewers', () => {
  test('When a scan ended then should return only the open ones', () => {
    const openInstance = open({ serviceName: 'api' });
    const ended = open({ serviceName: 'worker' });
    store.setLogReviewerState(ended.id, 'lr_failed');

    assert.deepEqual(idsOf(store.listOpenLogReviewers()), [openInstance.id]);
  });
});

function open(fields: { serviceName?: string; environmentName?: string } = {}): LogReviewer {
  return store.openLogReviewer({ repositoryId, ...fields });
}

function idsOf(instances: Array<{ id: string }>): string[] {
  return instances.map((instance) => instance.id);
}
