import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { LinearImplementerFields, Store } from './store.js';
import { LINEAR_IMPLEMENTER_TERMINAL_STATES } from './types.js';
import type { LinearImplementer, LinearImplementerState } from './types.js';
import { type StoreFixture, createTestStore } from '../testing/store.js';

const OPEN_STATES: LinearImplementerState[] = [
  'li_pending',
  'li_implementing',
  'li_verifying',
  'li_needs_human',
  'li_waiting_pr',
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

describe('Store.openLinearImplementer', () => {
  // Re-assigning a ticket whose pass is still running has to join that pass; the
  // partial unique index would reject a second open row anyway.
  const cases: Array<{ name: string; firstState: LinearImplementerState; wantSameRow: boolean }> = [
    ...OPEN_STATES.map((state) => ({
      name: `When the ticket is already \`${state}\` then should return that instance`,
      firstState: state,
      wantSameRow: true,
    })),
    ...LINEAR_IMPLEMENTER_TERMINAL_STATES.map((state) => ({
      name: `When the previous instance is \`${state}\` then should open a new one`,
      firstState: state,
      wantSameRow: false,
    })),
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const first = open();
      store.setLinearImplementerState(first.id, testCase.firstState);

      const second = open();

      assert.equal(second.id === first.id, testCase.wantSameRow);
    });
  }

  test('When the ticket has no instance then should open one pending', () => {
    const instance = open('issue-1', {
      promptContext: 'do the thing',
      linearSessionId: 'session-1',
    });

    assert.equal(instance.workflowState, 'li_pending');
    assert.equal(instance.repositoryId, repositoryId);
    assert.equal(instance.linearIssueIdentifier, 'JAR-1');
    assert.equal(instance.linearSessionId, 'session-1');
    assert.equal(instance.promptContext, 'do the thing');
    assert.equal(instance.iterationNumber, 0);
    assert.equal(instance.pullRequestNumber, null);
    assert.equal(instance.lastStateCheckedAt, null);
  });
});

describe('Store.getLinearImplementer', () => {
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

      const found = store.getLinearImplementer(testCase.id(stored.id));

      assert.deepEqual(found, testCase.wantFound ? stored : undefined);
    });
  }
});

describe('Store.findLinearImplementerByIssue', () => {
  const cases: Array<{ name: string; linearIssueId: string; wantFound: boolean }> = [
    {
      // An entry point has to tell "this ticket already ended" from "never seen".
      name: 'When the last instance ended then should still return it',
      linearIssueId: 'issue-1',
      wantFound: true,
    },
    {
      name: 'When the ticket was never seen then should return nothing',
      linearIssueId: 'issue-404',
      wantFound: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const instance = open();
      store.setLinearImplementerState(instance.id, 'li_done');

      const found = store.findLinearImplementerByIssue(testCase.linearIssueId);

      assert.equal(found?.id, testCase.wantFound ? instance.id : undefined);
      assert.equal(found?.workflowState, testCase.wantFound ? 'li_done' : undefined);
    });
  }

  test('When the ticket was worked twice then should return the newest instance', () => {
    const first = open();
    store.setLinearImplementerState(first.id, 'li_abandoned');
    store.db.prepare('UPDATE linear_implementer SET created_at = 1 WHERE id = ?').run(first.id);
    const second = open();

    assert.equal(store.findLinearImplementerByIssue('issue-1')?.id, second.id);
  });
});

describe('Store.findLinearImplementerByIdentifier', () => {
  const cases: Array<{ name: string; linearIssueIdentifier: string; wantFound: boolean }> = [
    {
      name: 'When the ticket was worked then should answer its row',
      linearIssueIdentifier: 'JAR-1',
      wantFound: true,
    },
    {
      // The identifier is written by hand wherever it comes from.
      name: 'When it is written in lower case then should still answer its row',
      linearIssueIdentifier: 'jar-1',
      wantFound: true,
    },
    {
      name: 'When no ticket carries that identifier then should answer nothing',
      linearIssueIdentifier: 'JAR-404',
      wantFound: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const instance = open();
      store.setLinearImplementerState(instance.id, 'li_done');

      assert.equal(
        store.findLinearImplementerByIdentifier(testCase.linearIssueIdentifier)?.id,
        testCase.wantFound ? instance.id : undefined,
      );
    });
  }

  test('When the ticket was worked twice then should answer the newest', () => {
    const first = open('issue-1');
    store.db.prepare('UPDATE linear_implementer SET created_at = 1 WHERE id = ?').run(first.id);
    store.setLinearImplementerState(first.id, 'li_abandoned');
    const second = open('issue-2');

    assert.equal(store.findLinearImplementerByIdentifier('JAR-1')?.id, second.id);
  });
});

describe('Store.findLinearImplementerByPullRequest', () => {
  const cases: Array<{
    name: string;
    repositoryId?: string;
    pullRequestNumber: number;
    wantFound: boolean;
  }> = [
    {
      name: 'When a ticket opened that pull request then should answer it',
      pullRequestNumber: 77,
      wantFound: true,
    },
    {
      name: 'When no ticket carries that number then should answer nothing',
      pullRequestNumber: 78,
      wantFound: false,
    },
    {
      // The number only identifies a pull request together with its repository.
      name: 'When the number belongs to another repository then should answer nothing',
      repositoryId: 'other',
      pullRequestNumber: 77,
      wantFound: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const instance = open();
      store.setLinearImplementerState(instance.id, 'li_waiting_pr', { pullRequestNumber: 77 });

      const found = store.findLinearImplementerByPullRequest(
        testCase.repositoryId ? store.upsertRepository('acme/other').id : repositoryId,
        testCase.pullRequestNumber,
      );

      assert.equal(found?.id, testCase.wantFound ? instance.id : undefined);
    });
  }

  test('When two tickets carried the same number then should answer the newest', () => {
    const first = open('issue-1');
    store.setLinearImplementerState(first.id, 'li_abandoned', { pullRequestNumber: 77 });
    store.db.prepare('UPDATE linear_implementer SET created_at = 1 WHERE id = ?').run(first.id);
    const second = open('issue-2');
    store.setLinearImplementerState(second.id, 'li_waiting_pr', { pullRequestNumber: 77 });

    assert.equal(store.findLinearImplementerByPullRequest(repositoryId, 77)?.id, second.id);
  });
});

describe('Store.setLinearImplementerState', () => {
  const FILLED: LinearImplementerFields = {
    linearSessionId: 'session-1',
    promptContext: 'the ask',
    pullRequestNumber: 12,
    iterationNumber: 3,
    verifiedCommitSha: 'abc123',
    verifierVerdict: 'reject',
    verifierIssues: 'tests missing',
    sandboxRunId: 'run-1',
    needsHumanReason: 'blocked',
  };

  // What the pass carries survives a transition that says nothing about it; what
  // describes one attempt is dropped, so the next attempt starts clean.
  const cases: Array<{ name: string; field: keyof LinearImplementer; wantKept: boolean }> = [
    { name: 'the linear session', field: 'linearSessionId', wantKept: true },
    { name: 'the prompt context', field: 'promptContext', wantKept: true },
    { name: 'the pull request', field: 'pullRequestNumber', wantKept: true },
    { name: 'the iteration count', field: 'iterationNumber', wantKept: true },
    { name: 'the verified commit', field: 'verifiedCommitSha', wantKept: true },
    { name: 'the verdict', field: 'verifierVerdict', wantKept: false },
    { name: 'the verifier issues', field: 'verifierIssues', wantKept: false },
    { name: 'the sandbox run', field: 'sandboxRunId', wantKept: false },
    { name: 'the human reason', field: 'needsHumanReason', wantKept: false },
  ];

  for (const testCase of cases) {
    const outcome = testCase.wantKept ? 'keep the stored value' : 'clear it';
    test(`When the next transition omits ${testCase.name} then should ${outcome}`, () => {
      const instance = open();
      store.setLinearImplementerState(instance.id, 'li_implementing', FILLED);

      store.setLinearImplementerState(instance.id, 'li_verifying');

      const stored = store.getLinearImplementer(instance.id) as LinearImplementer;
      assert.equal(
        stored[testCase.field] === FILLED[testCase.field as keyof LinearImplementerFields],
        testCase.wantKept,
      );
    });
  }

  test('When fields are given then should store them with the new state', () => {
    const instance = open();

    store.setLinearImplementerState(instance.id, 'li_verifying', FILLED);

    const stored = store.getLinearImplementer(instance.id) as LinearImplementer;
    assert.equal(stored.workflowState, 'li_verifying');
    for (const [field, value] of Object.entries(FILLED)) {
      assert.equal(stored[field as keyof LinearImplementer], value, field);
    }
  });

  // How long an instance has sat in one state is measured off state_changed_at, so
  // rewriting the same state must not reset it.
  const stateChangeCases: Array<{
    name: string;
    next: LinearImplementerState;
    wantMoved: boolean;
  }> = [
    {
      name: 'When the state changes then should move `state_changed_at`',
      next: 'li_implementing',
      wantMoved: true,
    },
    {
      name: 'When the state is written again then should keep `state_changed_at`',
      next: 'li_pending',
      wantMoved: false,
    },
  ];

  for (const testCase of stateChangeCases) {
    test(testCase.name, () => {
      const instance = open();
      store.db
        .prepare('UPDATE linear_implementer SET state_changed_at = 1 WHERE id = ?')
        .run(instance.id);

      store.setLinearImplementerState(instance.id, testCase.next);

      assert.equal(
        store.getLinearImplementer(instance.id)?.stateChangedAt !== 1,
        testCase.wantMoved,
      );
    });
  }
});

describe('Store.markLinearImplementerChecked', () => {
  test('When an instance is checked then should record when', () => {
    const instance = open();

    store.markLinearImplementerChecked(instance.id);

    assert.notEqual(store.getLinearImplementer(instance.id)?.lastStateCheckedAt, null);
  });
});

describe('Store.listLinearImplementersDue', () => {
  const dueCases: Array<{ name: string; arrange: () => LinearImplementer[] }> = [
    {
      name: 'When an instance is waiting past its wait then should return it',
      arrange: () => [open()],
    },
    {
      name: 'When several are due then should return the one longest in its state first',
      arrange: () => {
        const recent = open('issue-1');
        const waiting = open('issue-2');
        store.db
          .prepare('UPDATE linear_implementer SET state_changed_at = 1 WHERE id = ?')
          .run(waiting.id);
        return [waiting, recent];
      },
    },
  ];

  for (const testCase of dueCases) {
    test(testCase.name, () => {
      const want = testCase.arrange();

      const due = store.listLinearImplementersDue({ li_pending: 1_000 });

      assert.deepEqual(idsOf(due), idsOf(want));
    });
  }
});

describe('Store.listOpenLinearImplementers', () => {
  test('When an instance ended then should return only the open ones', () => {
    const openInstance = open();
    const ended = open('issue-2');
    store.setLinearImplementerState(ended.id, 'li_done');

    assert.deepEqual(idsOf(store.listOpenLinearImplementers()), [openInstance.id]);
  });
});

function open(
  linearIssueId = 'issue-1',
  fields: { promptContext?: string; linearSessionId?: string } = {},
): LinearImplementer {
  return store.openLinearImplementer({
    repositoryId,
    linearIssueId,
    linearIssueIdentifier: 'JAR-1',
    ...fields,
  });
}

function idsOf(instances: Array<{ id: string }>): string[] {
  return instances.map((instance) => instance.id);
}
