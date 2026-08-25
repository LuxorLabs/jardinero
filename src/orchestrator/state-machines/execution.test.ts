import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../store/store.js';
import type { SandboxRun, SandboxRunState } from '../../store/types.js';
import { type StoreFixture, createTestStore } from '../../testing/store.js';
import {
  asError,
  consumeRequest,
  countConsecutiveLostRuns,
  recordWorkflowInstanceOpened,
  recordWorkflowStateChange,
  retrieveWorkConversation,
} from './execution.js';

let fixture: StoreFixture;
let store: Store;

beforeEach(() => {
  fixture = createTestStore();
  store = fixture.store;
});

afterEach(() => {
  fixture.cleanup();
});

describe('asError', () => {
  const cases: Array<{ name: string; thrown: unknown; wantMessage: string }> = [
    {
      name: 'When an error is thrown then should pass it through',
      thrown: new Error('the machine refused it'),
      wantMessage: 'the machine refused it',
    },
    {
      name: 'When a string is thrown then should wrap it',
      thrown: 'not an error',
      wantMessage: 'not an error',
    },
    {
      name: 'When nothing is thrown then should wrap the empty value',
      thrown: undefined,
      wantMessage: 'undefined',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const error = asError(testCase.thrown);

      assert.ok(error instanceof Error);
      assert.equal(error.message, testCase.wantMessage);
    });
  }
});

describe('recordWorkflowStateChange', () => {
  const cases: Array<{ name: string; from: string; to: string; wantRecorded: boolean }> = [
    {
      name: 'When the state changed then should record the transition',
      from: 'prm_pending',
      to: 'prm_working',
      wantRecorded: true,
    },
    {
      name: 'When the state was rewritten then should record nothing',
      from: 'prm_waiting',
      to: 'prm_waiting',
      wantRecorded: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      recordWorkflowStateChange(
        store,
        'pr_maintainer',
        { id: 'instance-1', workflowState: testCase.from },
        testCase.to,
      );

      const events = store.listEventsForInstance('pr_maintainer', 'instance-1');
      assert.equal(events.length, testCase.wantRecorded ? 1 : 0);
    });
  }

  test('When a transition is recorded then should name both states', () => {
    recordWorkflowStateChange(
      store,
      'pr_maintainer',
      { id: 'instance-1', workflowState: 'prm_pending' },
      'prm_working',
    );

    const [event] = store.listEventsForInstance('pr_maintainer', 'instance-1');
    assert.equal(event.eventType, 'workflow.state_changed');
    assert.equal(event.workflowType, 'pr_maintainer');
    assert.equal(event.workflowInstanceId, 'instance-1');
    assert.equal(event.fromState, 'prm_pending');
    assert.equal(event.toState, 'prm_working');
    assert.deepEqual(JSON.parse(event.metadata ?? '{}'), {
      from_state: 'prm_pending',
      to_state: 'prm_working',
    });
  });
});

describe('recordWorkflowInstanceOpened', () => {
  const cases: Array<{
    name: string;
    subject: Record<string, unknown>;
    read(metadata: Record<string, unknown>): unknown;
    want: unknown;
  }> = [
    {
      name: 'When the instance is opened then should name the state it was born in',
      subject: {},
      read: (metadata) => metadata.state,
      want: 'fi_pending',
    },
    {
      name: 'When the subject is a finding then should name the fingerprint',
      subject: { finding_fingerprint: 'heimdall: authentication error' },
      read: (metadata) => metadata.finding_fingerprint,
      want: 'heimdall: authentication error',
    },
    {
      name: 'When the subject is a pull request then should name its number',
      subject: { pull_request_number: 4688 },
      read: (metadata) => metadata.pull_request_number,
      want: 4688,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const repositoryId = store.upsertRepository('acme/orchestrator').id;

      recordWorkflowInstanceOpened(
        store,
        'fix_implementer',
        { id: 'instance-1', workflowState: 'fi_pending', repositoryId },
        testCase.subject,
      );

      const [event] = store.listEventsForInstance('fix_implementer', 'instance-1');
      assert.equal(event.eventType, 'workflow.instance_opened');
      assert.equal(event.repositoryId, repositoryId);
      assert.equal(
        testCase.read(JSON.parse(event.metadata ?? '{}') as Record<string, unknown>),
        testCase.want,
      );
    });
  }
});

describe('countConsecutiveLostRuns', () => {
  const cases: Array<{ name: string; runs: SandboxRunState[]; since?: number; want: number }> = [
    {
      name: 'When the instance never ran then should count nothing',
      runs: [],
      want: 0,
    },
    {
      name: 'When the last run failed then should count it',
      runs: ['failed'],
      want: 1,
    },
    {
      name: 'When the last run was orphaned then should count it',
      runs: ['orphaned'],
      want: 1,
    },
    {
      name: 'When the last run was aborted then should count it',
      runs: ['aborted'],
      want: 1,
    },
    {
      name: 'When the last run succeeded then should count nothing',
      runs: ['succeeded'],
      want: 0,
    },
    {
      name: 'When the last run was skipped then should count nothing',
      runs: ['skipped'],
      want: 0,
    },
    {
      name: 'When an answer came after the lost runs then should count nothing',
      runs: ['failed', 'orphaned', 'succeeded'],
      want: 0,
    },
    {
      name: 'When the runs kept dying after an answer then should count only those',
      runs: ['failed', 'succeeded', 'failed', 'orphaned'],
      want: 2,
    },
    {
      name: 'When a run is still in flight then should count past it',
      runs: ['failed', 'running'],
      want: 1,
    },
    {
      name: 'When a lost run started before the window then should leave it out',
      runs: ['failed', 'failed', 'failed'],
      since: 2,
      want: 1,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const reader = readerOf(testCase.runs);

      assert.equal(
        countConsecutiveLostRuns(reader, 'fix_implementer', 'instance-1', testCase.since ?? 0),
        testCase.want,
      );
    });
  }
});

describe('consumeRequest', () => {
  const cases: Array<{ name: string; withAsk: boolean }> = [
    {
      name: 'When the caller carries an ask then should record which instance answered it',
      withAsk: true,
    },
    {
      name: 'When the caller carries no ask then should record nothing',
      withAsk: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const repositoryId = store.upsertRepository('acme/orchestrator').id;
      const ask = store.createRequest({
        requestSource: 'github',
        repositoryId,
        subjectType: 'pull_request',
        subjectExternalId: '7',
      });

      const answering = { id: 'instance-1', repositoryId: store.upsertRepository('a/b').id };

      consumeRequest(store, 'pr_maintainer', testCase.withAsk ? ask.id : undefined, answering);

      const stored = store.getRequest(ask.id);
      assert.equal(stored?.workflowInstanceId, testCase.withAsk ? 'instance-1' : null);
      assert.equal(stored?.workflowType, testCase.withAsk ? 'pr_maintainer' : null);
      assert.equal(stored?.consumedAt !== null, testCase.withAsk);
      // The work answers where it opened, which is not always where the door guessed.
      assert.equal(stored?.repositoryId, testCase.withAsk ? answering.repositoryId : repositoryId);
    });
  }
});

describe('retrieveWorkConversation', () => {
  const cases: Array<{
    name: string;
    withRequest: boolean;
    requesterExternalId?: string;
    wantAskedBy?: { source: string; externalId: string };
  }> = [
    {
      name: 'When a request carries who asked then should name them in its own identity',
      withRequest: true,
      requesterExternalId: '1001',
      wantAskedBy: { source: 'discord', externalId: '1001' },
    },
    {
      name: 'When the request names nobody then should leave the work unattributed',
      withRequest: true,
      wantAskedBy: undefined,
    },
    {
      name: 'When the work was not asked for then should leave it unattributed',
      withRequest: false,
      wantAskedBy: undefined,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const repositoryId = store.upsertRepository('acme/orchestrator').id;
      const request = store.createRequest({
        requestSource: 'discord',
        repositoryId,
        requesterExternalId: testCase.requesterExternalId,
      });

      const conversation = retrieveWorkConversation(store, {
        key: 'linear_issue:JAR-58',
        name: 'JAR-58',
        repositoryId,
        workflowInstanceId: 'instance-1',
        requestRouterId: testCase.withRequest ? request.id : null,
      });

      assert.deepEqual(conversation, {
        key: 'linear_issue:JAR-58',
        name: 'JAR-58',
        repositoryId,
        workflowInstanceId: 'instance-1',
        ...(testCase.wantAskedBy ? { askedBy: testCase.wantAskedBy } : {}),
      });
    });
  }
});

function readerOf(states: SandboxRunState[]): Pick<Store, 'listSandboxRunsForInstance'> {
  return {
    listSandboxRunsForInstance: (workflowType, workflowInstanceId) =>
      states.map((runState, index) => ({
        id: `run-${index}`,
        agentName: 'FixImplementer',
        runState,
        workflowType,
        workflowInstanceId,
        sandboxSessionId: null,
        costUsd: null,
        errorMessage: null,
        startedAt: index,
        endedAt: null,
      })) satisfies SandboxRun[],
  };
}
