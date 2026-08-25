import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../store/store.js';
import { type StoreFixture, createTestStore } from '../testing/store.js';
import { type OpenWork, listOpenWork, listWorkInConversation } from './open-work.js';

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

describe('listOpenWork', () => {
  const cases: Array<{
    name: string;
    arrange(): void;
    repositoryFullName?: string;
    want: Array<Pick<OpenWork, 'name' | 'happening' | 'needsPerson'>>;
  }> = [
    {
      name: 'When a ticket is being written then should answer it by its identifier',
      arrange: () => openTicket('li_implementing'),
      want: [{ name: 'JAR-58', happening: 'being written', needsPerson: false }],
    },
    {
      name: 'When a ticket is waiting for a person then should say that it is',
      arrange: () => openTicket('li_needs_human'),
      want: [{ name: 'JAR-58', happening: 'waiting for a person', needsPerson: true }],
    },
    {
      name: 'When a fix names its service then should answer it by that service',
      arrange: () => openFix('fi_implementing', 'engine'),
      want: [{ name: 'a fix for engine', happening: 'being written', needsPerson: false }],
    },
    {
      name: 'When a fix names no service then should answer it by the logs',
      arrange: () => openFix('fi_verifying'),
      want: [{ name: 'a fix for the logs', happening: 'being verified', needsPerson: false }],
    },
    {
      name: 'When a pull request is maintained then should answer it by its number',
      arrange: () => openPullRequest('prm_working'),
      want: [{ name: '#4688', happening: 'answering its review', needsPerson: false }],
    },
    {
      // The machines are asked in turn, so one open instance of each is one line each.
      name: 'When work is open in every machine then should answer all of it',
      arrange: () => {
        openTicket('li_verifying');
        openFix('fi_waiting_pr', 'engine');
        openPullRequest('prm_waiting');
      },
      want: [
        { name: 'JAR-58', happening: 'being verified', needsPerson: false },
        { name: 'a fix for engine', happening: 'waiting on its pull request', needsPerson: false },
        { name: '#4688', happening: 'waiting for a review', needsPerson: false },
      ],
    },
    {
      name: 'When work has ended then should leave it out',
      arrange: () => openTicket('li_done'),
      want: [],
    },
    {
      name: 'When another repository is named then should answer nothing of ours',
      arrange: () => openTicket('li_implementing'),
      repositoryFullName: 'acme/webapp',
      want: [],
    },
    {
      // The name is written by hand wherever it comes from, so the case must not decide it.
      name: 'When the repository is named in another case then should still answer its work',
      arrange: () => openTicket('li_implementing'),
      repositoryFullName: 'acme/ORCHESTRATOR',
      want: [{ name: 'JAR-58', happening: 'being written', needsPerson: false }],
    },
    {
      name: 'When nothing is open then should answer nothing',
      arrange: () => {},
      want: [],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      testCase.arrange();

      assert.deepEqual(
        listOpenWork(store, testCase.repositoryFullName ?? 'acme/orchestrator').map((work) => ({
          name: work.name,
          happening: work.happening,
          needsPerson: work.needsPerson,
        })),
        testCase.want,
      );
    });
  }

  test('When no repository is named then should answer every one', () => {
    const other = store.upsertRepository('acme/webapp').id;
    openTicket('li_implementing');
    const elsewhere = store.openLinearImplementer({
      repositoryId: other,
      linearIssueId: 'issue-2',
      linearIssueIdentifier: 'SUP-1',
    });
    store.setLinearImplementerState(elsewhere.id, 'li_implementing');

    assert.deepEqual(
      listOpenWork(store).map((work) => `${work.name} in ${work.repositoryFullName}`),
      ['JAR-58 in acme/orchestrator', 'SUP-1 in acme/webapp'],
    );
  });

  test('When the named repository is one we never saw then should answer nothing', () => {
    openTicket('li_implementing');

    assert.deepEqual(listOpenWork(store, 'acme/unknown'), []);
  });
});

describe('listWorkInConversation', () => {
  const cases: Array<{
    name: string;
    arrange(): void;
    conversationKey: string;
    want: Array<{ name: string; happening: string }>;
  }> = [
    {
      name: 'When the ticket is still being written then should answer only the ticket',
      arrange: () => openTicket('li_implementing'),
      conversationKey: 'linear_issue:JAR-58',
      want: [{ name: 'JAR-58', happening: 'being written' }],
    },
    {
      // The pull request is the other half of the same conversation.
      name: 'When the ticket released a pull request then should answer both',
      arrange: () => {
        openTicket('li_waiting_pr', 4688);
        openPullRequest('prm_waiting');
      },
      conversationKey: 'linear_issue:JAR-58',
      want: [
        { name: 'JAR-58', happening: 'waiting on its pull request' },
        { name: '#4688', happening: 'waiting for a review' },
      ],
    },
    {
      // A conversation outlives the work, and what became of it is the answer.
      name: 'When the work ended then should answer how it ended',
      arrange: () => {
        openTicket('li_done', 4688);
        openPullRequest('prm_merged');
      },
      conversationKey: 'linear_issue:JAR-58',
      want: [
        { name: 'JAR-58', happening: 'merged' },
        { name: '#4688', happening: 'merged' },
      ],
    },
    {
      name: 'When the ticket is written in another case then should still answer it',
      arrange: () => openTicket('li_implementing'),
      conversationKey: 'linear_issue:jar-58',
      want: [{ name: 'JAR-58', happening: 'being written' }],
    },
    {
      name: 'When no ticket was ever worked then should answer nothing',
      arrange: () => {},
      conversationKey: 'linear_issue:JAR-58',
      want: [],
    },
    {
      // Only a ticket's conversation names what it is about; a pull request's does not.
      name: 'When the conversation is not about a ticket then should answer nothing',
      arrange: () => openTicket('li_implementing'),
      conversationKey: 'pull_request:repo:4688',
      want: [],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      testCase.arrange();

      assert.deepEqual(
        listWorkInConversation(store, testCase.conversationKey).map((work) => ({
          name: work.name,
          happening: work.happening,
        })),
        testCase.want,
      );
    });
  }
});

function openTicket(state: string, pullRequestNumber?: number): void {
  const instance = store.openLinearImplementer({
    repositoryId,
    linearIssueId: 'issue-1',
    linearIssueIdentifier: 'JAR-58',
  });
  store.setLinearImplementerState(instance.id, state as never, {
    ...(pullRequestNumber ? { pullRequestNumber } : {}),
  });
}

function openFix(state: string, serviceName?: string): void {
  const instance = store.openFixImplementer({
    repositoryId,
    findingFingerprint: 'fp-1',
    ...(serviceName ? { serviceName } : {}),
  });
  store.setFixImplementerState(instance.id, state as never);
}

function openPullRequest(state: string): void {
  const instance = store.openPrMaintainer({ repositoryId, pullRequestNumber: 4688 });
  store.setPrMaintainerState(instance.id, state as never);
}
