import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from './store.js';
import type { RequestRouter, RequestRouterState } from './types.js';
import { type StoreFixture, createTestStore } from '../testing/store.js';

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

describe('Store.createRequest', () => {
  // A request that already names its subject has nothing to route, so it is born
  // resolved and only free text waits for the Router.
  const cases: Array<{ name: string; subject: boolean; wantState: RequestRouterState }> = [
    {
      name: 'When the request carries no subject then should open it pending',
      subject: false,
      wantState: 'rr_pending',
    },
    {
      name: 'When the request names its subject then should open it resolved',
      subject: true,
      wantState: 'rr_resolved',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const request = store.createRequest({
        requestSource: 'discord',
        requestText: 'fix the login page',
        ...(testCase.subject
          ? { subjectType: 'pull_request' as const, subjectExternalId: '42' }
          : {}),
      });

      assert.equal(request.workflowState, testCase.wantState);
    });
  }

  test('When the request is created then should store what the source said', () => {
    const request = store.createRequest({
      requestSource: 'discord',
      requestText: 'fix the login page',
      requesterExternalId: 'discord-user-1',
      replyTargetType: 'discord_thread',
      replyTargetId: 'thread-1',
      repositoryId,
    });

    assert.equal(request.requestSource, 'discord');
    assert.equal(request.requestText, 'fix the login page');
    assert.equal(request.requesterExternalId, 'discord-user-1');
    assert.equal(request.replyTargetType, 'discord_thread');
    assert.equal(request.replyTargetId, 'thread-1');
    assert.equal(request.repositoryId, repositoryId);
    assert.equal(request.consumedAt, null);
    assert.equal(request.lastStateCheckedAt, null);
  });
});

describe('Store.getRequest', () => {
  const cases: Array<{ name: string; id(storedId: string): string; wantFound: boolean }> = [
    {
      name: 'When the id is known then should return the request',
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
      const stored = store.createRequest({ requestSource: 'cron' });

      const found = store.getRequest(testCase.id(stored.id));

      assert.deepEqual(found, testCase.wantFound ? stored : undefined);
    });
  }
});

describe('Store.setRequestState', () => {
  const cases: Array<{
    name: string;
    second: Parameters<Store['setRequestState']>[2];
    want: Partial<RequestRouter>;
  }> = [
    {
      name: 'When the subject is resolved then should store it',
      second: {
        subjectType: 'linear_issue',
        subjectExternalId: 'issue-9',
        resolutionNote: 'matched by identifier',
      },
      want: {
        subjectType: 'linear_issue',
        subjectExternalId: 'issue-9',
        resolutionNote: 'matched by identifier',
      },
    },
    {
      // Routing is the one write that fills these, so a later transition that says
      // nothing about them must not lose the subject the Router found.
      name: 'When a field is omitted then should keep the stored value',
      second: {},
      want: {
        subjectType: 'pull_request',
        subjectExternalId: '42',
        resolutionNote: 'first note',
        sandboxRunId: 'run-1',
      },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const request = store.createRequest({ requestSource: 'discord' });
      store.setRequestState(request.id, 'rr_routing', {
        subjectType: 'pull_request',
        subjectExternalId: '42',
        resolutionNote: 'first note',
        sandboxRunId: 'run-1',
      });

      store.setRequestState(request.id, 'rr_resolved', testCase.second);

      const stored = store.getRequest(request.id) as RequestRouter;
      assert.equal(stored.workflowState, 'rr_resolved');
      for (const [field, value] of Object.entries(testCase.want)) {
        assert.equal(stored[field as keyof RequestRouter], value, field);
      }
    });
  }

  // How long an instance has sat in one state is measured off state_changed_at, so
  // rewriting the same state must not reset it.
  const stateChangeCases: Array<{ name: string; next: RequestRouterState; wantMoved: boolean }> = [
    {
      name: 'When the state changes then should move `state_changed_at`',
      next: 'rr_routing',
      wantMoved: true,
    },
    {
      name: 'When the state is written again then should keep `state_changed_at`',
      next: 'rr_pending',
      wantMoved: false,
    },
  ];

  for (const testCase of stateChangeCases) {
    test(testCase.name, () => {
      const request = store.createRequest({ requestSource: 'discord' });
      rewind(store, 'request_router', request.id, 'state_changed_at');

      store.setRequestState(request.id, testCase.next);

      assert.equal(store.getRequest(request.id)?.stateChangedAt !== 1, testCase.wantMoved);
    });
  }
});

describe('Store.markRequestChecked', () => {
  test('When an instance is checked then should record when', () => {
    const request = store.createRequest({ requestSource: 'discord' });

    store.markRequestChecked(request.id);

    assert.notEqual(store.getRequest(request.id)?.lastStateCheckedAt, null);
  });
});

describe('Store.listRequestsDue', () => {
  const cases: Array<{
    name: string;
    state: RequestRouterState;
    checked: boolean;
    waits: Partial<Record<RequestRouterState, number>>;
    wantDue: boolean;
  }> = [
    {
      name: 'When an instance was never checked then should return it',
      state: 'rr_pending',
      checked: false,
      waits: { rr_pending: 1_000 },
      wantDue: true,
    },
    {
      name: 'When an instance was just checked then should skip it',
      state: 'rr_pending',
      checked: true,
      waits: { rr_pending: 1_000 },
      wantDue: false,
    },
    {
      // A state with no wait is a state nothing revisits on a tick.
      name: 'When its state has no wait then should skip it',
      state: 'rr_pending',
      checked: false,
      waits: { rr_routing: 1_000 },
      wantDue: false,
    },
    {
      name: 'When the instance is terminal then should skip it',
      state: 'rr_resolved',
      checked: false,
      waits: { rr_resolved: 1_000 },
      wantDue: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const request = store.createRequest({ requestSource: 'discord' });
      store.setRequestState(request.id, testCase.state);
      if (testCase.checked) store.markRequestChecked(request.id);

      const due = store.listRequestsDue(testCase.waits);

      assert.equal(
        due.some((instance) => instance.id === request.id),
        testCase.wantDue,
      );
    });
  }
});

describe('Store.listOpenRequests', () => {
  test('When some requests ended then should return the open ones oldest first', () => {
    const first = store.createRequest({ requestSource: 'discord' });
    const second = store.createRequest({ requestSource: 'discord' });
    const ended = store.createRequest({ requestSource: 'discord' });
    store.setRequestState(ended.id, 'rr_unresolvable');

    assert.deepEqual(idsOf(store.listOpenRequests()), [first.id, second.id]);
  });
});

describe('Store.listUnconsumedRequests', () => {
  const cases: Array<{
    name: string;
    subjectExternalId: string;
    scoped: boolean;
    wantIds(ours: string, theirs: string): string[];
  }> = [
    {
      name: 'When a repository is given then should return only its requests',
      subjectExternalId: '7',
      scoped: true,
      wantIds: (ours) => [ours],
    },
    {
      // A pull request number only identifies a PR inside its repository, so
      // asking without one is asking about every repository.
      name: 'When no repository is given then should return every repository',
      subjectExternalId: '7',
      scoped: false,
      wantIds: (ours, theirs) => [ours, theirs],
    },
    {
      name: 'When the subject is unknown then should return an empty list',
      subjectExternalId: '9',
      scoped: false,
      wantIds: () => [],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const otherRepositoryId = store.upsertRepository('acme/webapp').id;
      const ours = pullRequestRequest(store, repositoryId, '7');
      const theirs = pullRequestRequest(store, otherRepositoryId, '7');

      const unconsumed = store.listUnconsumedRequests(
        'pull_request',
        testCase.subjectExternalId,
        testCase.scoped ? repositoryId : undefined,
      );

      assert.deepEqual(idsOf(unconsumed), testCase.wantIds(ours.id, theirs.id));
    });
  }

  test('When a request was consumed then should leave it out', () => {
    const waiting = pullRequestRequest(store, repositoryId, '7');
    const consumed = pullRequestRequest(store, repositoryId, '7');
    store.markRequestConsumed(consumed.id, 'pr_maintainer', 'instance-1', repositoryId);

    const unconsumed = store.listUnconsumedRequests('pull_request', '7', repositoryId);

    assert.deepEqual(idsOf(unconsumed), [waiting.id]);
  });
});

describe('Store.markRequestConsumed', () => {
  test('When a workflow takes a request then should record which instance took it', () => {
    const request = store.createRequest({ requestSource: 'discord' });

    store.markRequestConsumed(request.id, 'linear_implementer', 'instance-1', repositoryId);

    const stored = store.getRequest(request.id);
    assert.equal(stored?.workflowType, 'linear_implementer');
    assert.equal(stored?.workflowInstanceId, 'instance-1');
    assert.equal(stored?.repositoryId, repositoryId);
    assert.notEqual(stored?.consumedAt, null);
  });
});

function pullRequestRequest(
  target: Store,
  repository: string,
  pullRequestNumber: string,
): RequestRouter {
  return target.createRequest({
    requestSource: 'github',
    repositoryId: repository,
    subjectType: 'pull_request',
    subjectExternalId: pullRequestNumber,
  });
}

// The clock cannot be moved, so an old timestamp is written directly.
function rewind(target: Store, table: string, id: string, column: string): void {
  target.db.prepare(`UPDATE ${table} SET ${column} = 1 WHERE id = ?`).run(id);
}

function idsOf(instances: Array<{ id: string }>): string[] {
  return instances.map((instance) => instance.id);
}
