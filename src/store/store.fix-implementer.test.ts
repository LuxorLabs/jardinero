import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { FixImplementerFields, Store } from './store.js';
import { FIX_IMPLEMENTER_TERMINAL_STATES } from './types.js';
import type { FixImplementer, FixImplementerState } from './types.js';
import { type StoreFixture, createTestStore } from '../testing/store.js';

const OPEN_STATES: FixImplementerState[] = [
  'fi_pending',
  'fi_implementing',
  'fi_verifying',
  'fi_needs_human',
  'fi_waiting_pr',
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

describe('Store.openFixImplementer', () => {
  // One open instance per finding is what stops the same error being fixed twice
  // because two scans reported it.
  const cases: Array<{ name: string; firstState: FixImplementerState; wantSameRow: boolean }> = [
    ...OPEN_STATES.map((state) => ({
      name: `When the finding is already \`${state}\` then should return that instance`,
      firstState: state,
      wantSameRow: true,
    })),
    ...FIX_IMPLEMENTER_TERMINAL_STATES.map((state) => ({
      name: `When the previous instance is \`${state}\` then should open a new one`,
      firstState: state,
      wantSameRow: false,
    })),
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const first = open();
      store.setFixImplementerState(first.id, testCase.firstState);

      const second = open();

      assert.equal(second.id === first.id, testCase.wantSameRow);
    });
  }

  test('When the finding has no instance then should open one pending', () => {
    const instance = open('fingerprint-1', {
      serviceName: 'api',
      environmentName: 'staging',
      findingEvidence: 'null pointer in handler',
    });

    assert.equal(instance.workflowState, 'fi_pending');
    assert.equal(instance.repositoryId, repositoryId);
    assert.equal(instance.findingFingerprint, 'fingerprint-1');
    assert.equal(instance.serviceName, 'api');
    assert.equal(instance.environmentName, 'staging');
    assert.equal(instance.findingEvidence, 'null pointer in handler');
    assert.equal(instance.pullRequestNumber, null);
    assert.equal(instance.lastStateCheckedAt, null);
  });
});

describe('Store.getFixImplementer', () => {
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

      const found = store.getFixImplementer(testCase.id(stored.id));

      assert.deepEqual(found, testCase.wantFound ? stored : undefined);
    });
  }
});

describe('Store.findFixImplementerByFingerprint', () => {
  const cases: Array<{ name: string; fingerprint: string; wantFound: boolean }> = [
    {
      // A finding already refused must not be re-opened by the next scan that sees it.
      name: 'When the last instance ended then should still return it',
      fingerprint: 'fingerprint-1',
      wantFound: true,
    },
    {
      name: 'When the finding was never seen then should return nothing',
      fingerprint: 'fingerprint-404',
      wantFound: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const instance = open();
      store.setFixImplementerState(instance.id, 'fi_discarded', { discardReason: 'not a bug' });

      const found = store.findFixImplementerByFingerprint(testCase.fingerprint);

      assert.equal(found?.id, testCase.wantFound ? instance.id : undefined);
      assert.equal(found?.discardReason, testCase.wantFound ? 'not a bug' : undefined);
    });
  }

  test('When the finding was worked twice then should return the newest instance', () => {
    const first = open();
    store.setFixImplementerState(first.id, 'fi_abandoned');
    store.db.prepare('UPDATE fix_implementer SET created_at = 1 WHERE id = ?').run(first.id);
    const second = open();

    assert.equal(store.findFixImplementerByFingerprint('fingerprint-1')?.id, second.id);
  });
});

describe('Store.setFixImplementerState', () => {
  const FILLED: FixImplementerFields = {
    pullRequestNumber: 12,
    verifiedCommitSha: 'abc123',
    verifierVerdict: 'reject',
    verifierIssues: 'tests missing',
    sandboxRunId: 'run-1',
    needsHumanReason: 'blocked',
    discardReason: 'not a bug',
  };

  // What the fix carries survives a transition that says nothing about it; what
  // describes one attempt is dropped, so the next attempt starts clean.
  const cases: Array<{ name: string; field: keyof FixImplementer; wantKept: boolean }> = [
    { name: 'the pull request', field: 'pullRequestNumber', wantKept: true },
    { name: 'the verified commit', field: 'verifiedCommitSha', wantKept: true },
    { name: 'the verdict', field: 'verifierVerdict', wantKept: false },
    { name: 'the verifier issues', field: 'verifierIssues', wantKept: false },
    { name: 'the sandbox run', field: 'sandboxRunId', wantKept: false },
    { name: 'the human reason', field: 'needsHumanReason', wantKept: false },
    { name: 'the discard reason', field: 'discardReason', wantKept: false },
  ];

  for (const testCase of cases) {
    const outcome = testCase.wantKept ? 'keep the stored value' : 'clear it';
    test(`When the next transition omits ${testCase.name} then should ${outcome}`, () => {
      const instance = open();
      store.setFixImplementerState(instance.id, 'fi_implementing', FILLED);

      store.setFixImplementerState(instance.id, 'fi_verifying');

      const stored = store.getFixImplementer(instance.id) as FixImplementer;
      assert.equal(
        stored[testCase.field] === FILLED[testCase.field as keyof FixImplementerFields],
        testCase.wantKept,
      );
    });
  }

  test('When fields are given then should store them with the new state', () => {
    const instance = open();

    store.setFixImplementerState(instance.id, 'fi_verifying', FILLED);

    const stored = store.getFixImplementer(instance.id) as FixImplementer;
    assert.equal(stored.workflowState, 'fi_verifying');
    for (const [field, value] of Object.entries(FILLED)) {
      assert.equal(stored[field as keyof FixImplementer], value, field);
    }
  });

  const stateChangeCases: Array<{ name: string; next: FixImplementerState; wantMoved: boolean }> = [
    {
      name: 'When the state changes then should move `state_changed_at`',
      next: 'fi_implementing',
      wantMoved: true,
    },
    {
      name: 'When the state is written again then should keep `state_changed_at`',
      next: 'fi_pending',
      wantMoved: false,
    },
  ];

  for (const testCase of stateChangeCases) {
    test(testCase.name, () => {
      const instance = open();
      store.db
        .prepare('UPDATE fix_implementer SET state_changed_at = 1 WHERE id = ?')
        .run(instance.id);

      store.setFixImplementerState(instance.id, testCase.next);

      assert.equal(store.getFixImplementer(instance.id)?.stateChangedAt !== 1, testCase.wantMoved);
    });
  }
});

describe('Store.markFixImplementerChecked', () => {
  test('When an instance is checked then should record when', () => {
    const instance = open();

    store.markFixImplementerChecked(instance.id);

    assert.notEqual(store.getFixImplementer(instance.id)?.lastStateCheckedAt, null);
  });
});

describe('Store.listFixImplementersDue', () => {
  test('When an instance is waiting past its wait then should return it', () => {
    const instance = open();

    assert.deepEqual(idsOf(store.listFixImplementersDue({ fi_pending: 1_000 })), [instance.id]);
  });
});

describe('Store.listOpenFixImplementers', () => {
  test('When an instance ended then should return only the open ones', () => {
    const openInstance = open();
    const ended = open('fingerprint-2');
    store.setFixImplementerState(ended.id, 'fi_done');

    assert.deepEqual(idsOf(store.listOpenFixImplementers()), [openInstance.id]);
  });
});

describe('Store.listAbandonedFixImplementers', () => {
  const cases: Array<{
    name: string;
    scope: { serviceName?: string; environmentName?: string };
    want: boolean;
  }> = [
    {
      name: 'When the target matches then should return the finding',
      scope: { serviceName: 'api', environmentName: 'production' },
      want: true,
    },
    {
      name: 'When another service is asked for then should return nothing',
      scope: { serviceName: 'web', environmentName: 'production' },
      want: false,
    },
    {
      name: 'When another environment is asked for then should return nothing',
      scope: { serviceName: 'api', environmentName: 'staging' },
      want: false,
    },
    {
      name: 'When the target carries no service or environment then should return nothing',
      scope: {},
      want: false,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const abandoned = open('fingerprint-abandoned', {
        serviceName: 'api',
        environmentName: 'production',
      });
      store.setFixImplementerState(abandoned.id, 'fi_abandoned');

      const found = store.listAbandonedFixImplementers({ repositoryId, ...c.scope });

      assert.deepEqual(idsOf(found), c.want ? [abandoned.id] : []);
    });
  }

  test('When the finding has not ended that way then should return nothing', () => {
    const discarded = open('fingerprint-discarded', {
      serviceName: 'api',
      environmentName: 'production',
    });
    store.setFixImplementerState(discarded.id, 'fi_discarded');

    assert.deepEqual(
      store.listAbandonedFixImplementers({
        repositoryId,
        serviceName: 'api',
        environmentName: 'production',
      }),
      [],
    );
  });
});

describe('Store.listOpenFixImplementersForTarget', () => {
  const cases: Array<{ name: string; state: FixImplementerState; want: boolean }> = [
    ...OPEN_STATES.map((state) => ({
      name: `When the finding is \`${state}\` then should return it`,
      state,
      want: true,
    })),
    ...FIX_IMPLEMENTER_TERMINAL_STATES.map((state) => ({
      name: `When the finding is \`${state}\` then should return nothing`,
      state,
      want: false,
    })),
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = open('fingerprint-open', {
        serviceName: 'api',
        environmentName: 'production',
      });
      store.setFixImplementerState(instance.id, c.state);

      const found = store.listOpenFixImplementersForTarget({
        repositoryId,
        serviceName: 'api',
        environmentName: 'production',
      });

      assert.deepEqual(idsOf(found), c.want ? [instance.id] : []);
    });
  }

  const scopeCases: Array<{
    name: string;
    scope: { serviceName?: string; environmentName?: string };
    want: boolean;
  }> = [
    {
      name: 'When another service is asked for then should return nothing',
      scope: { serviceName: 'web', environmentName: 'production' },
      want: false,
    },
    {
      name: 'When another environment is asked for then should return nothing',
      scope: { serviceName: 'api', environmentName: 'staging' },
      want: false,
    },
    {
      name: 'When the target carries no service or environment then should return nothing',
      scope: {},
      want: false,
    },
  ];

  for (const c of scopeCases) {
    test(c.name, () => {
      const instance = open('fingerprint-open', {
        serviceName: 'api',
        environmentName: 'production',
      });

      const found = store.listOpenFixImplementersForTarget({ repositoryId, ...c.scope });

      assert.deepEqual(idsOf(found), c.want ? [instance.id] : []);
    });
  }
});

function open(
  findingFingerprint = 'fingerprint-1',
  fields: { serviceName?: string; environmentName?: string; findingEvidence?: string } = {},
): FixImplementer {
  return store.openFixImplementer({ repositoryId, findingFingerprint, ...fields });
}

function idsOf(instances: Array<{ id: string }>): string[] {
  return instances.map((instance) => instance.id);
}
