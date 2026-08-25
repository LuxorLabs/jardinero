import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { AppendEventInput, Store } from './store.js';
import { captureLogs } from '../testing/logger.js';
import { type StoreFixture, createTestStore } from '../testing/store.js';

let fixture: StoreFixture;
let store: Store;
let sandboxRunId: string;

beforeEach(() => {
  fixture = createTestStore();
  store = fixture.store;
  sandboxRunId = store.startSandboxRun({
    agentName: 'pr-maintainer',
    workflowType: 'pr_maintainer',
    workflowInstanceId: 'instance-1',
  }).id;
});

afterEach(() => {
  fixture.cleanup();
});

describe('Store.appendEvent', () => {
  const cases: Array<{ name: string; input: AppendEventInput; wantMetadata: string | null }> = [
    {
      name: 'When the event carries metadata then should store it encoded',
      input: { eventType: 'tenki.exec', metadata: { command: 'npm test' } },
      wantMetadata: '{"command":"npm test"}',
    },
    {
      name: 'When the event carries no metadata then should leave it empty',
      input: { eventType: 'sandbox.ready' },
      wantMetadata: null,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      store.appendEvent({ ...testCase.input, sandboxRunId });

      const [entry] = store.listEventsForSandboxRun(sandboxRunId);
      assert.equal(entry.eventType, testCase.input.eventType);
      assert.equal(entry.metadata, testCase.wantMetadata);
    });
  }

  test('When the event names no workflow then should store it as a system event', () => {
    store.appendEvent({ eventType: 'orchestrator.started' });

    const [entry] = store.listEventsForInstance('pr_maintainer', 'instance-1');
    assert.equal(entry, undefined);
  });

  test('When a system moment is recorded then should belong to no workflow', () => {
    store.appendEvent({ eventType: 'orchestrator.started', metadata: { worker_runner: 'tenki' } });

    const [entry] = store.queryReadOnly(
      'SELECT event_type, workflow_type, metadata FROM event_log WHERE event_type = ?',
      ['orchestrator.started'],
    ) as Array<{ event_type: string; workflow_type: string | null; metadata: string }>;
    assert.equal(entry.workflow_type, null);
    assert.deepEqual(JSON.parse(entry.metadata), { worker_runner: 'tenki' });
  });

  test('When the event carries a transition then should store both states', () => {
    store.appendEvent({
      eventType: 'state_changed',
      workflowType: 'pr_maintainer',
      workflowInstanceId: 'instance-1',
      fromState: 'prm_pending',
      toState: 'prm_working',
    });

    const [entry] = store.listEventsForInstance('pr_maintainer', 'instance-1');
    assert.equal(entry.fromState, 'prm_pending');
    assert.equal(entry.toState, 'prm_working');
  });

  test('When the event is not a transition then should leave both states empty', () => {
    store.appendEvent({ eventType: 'tenki.exec', sandboxRunId });

    const [entry] = store.listEventsForSandboxRun(sandboxRunId);
    assert.equal(entry.fromState, null);
    assert.equal(entry.toState, null);
  });

  // The log is never read to decide anything, so a write that cannot land must not
  // take the caller down with it.
  test('When the write fails then should not throw', () => {
    store.db.exec('DROP TABLE event_log');

    assert.doesNotThrow(() => store.appendEvent({ eventType: 'tenki.exec' }));
  });
});

describe('Store.appendEvent mirrors', () => {
  const cases: Array<{ name: string; input: AppendEventInput; wantLevel?: 'info' | 'warn' }> = [
    {
      name: 'When a system event is recorded then should mirror it as info',
      input: { eventType: 'orchestrator.started', metadata: { worker_runner: 'tenki' } },
      wantLevel: 'info',
    },
    {
      name: 'When an operator write is recorded then should mirror it as info',
      input: { eventType: 'operator.prompt_saved', metadata: { repo: 'acme/orchestrator' } },
      wantLevel: 'info',
    },
    {
      name: 'When the system event is a failure then should mirror it as a warning',
      input: { eventType: 'orchestrator.linear_reply_failed', metadata: { error: 'boom' } },
      wantLevel: 'warn',
    },
    {
      name: 'When runs were left by a dead process then should mirror it as a warning',
      input: { eventType: 'orchestrator.runs_left_by_dead_process', metadata: { count: 2 } },
      wantLevel: 'warn',
    },
    {
      // An instance has its own timeline, so its events would drown the terminal.
      name: 'When the event belongs to an instance then should mirror nothing',
      input: {
        eventType: 'workflow.state_changed',
        workflowType: 'pr_maintainer',
        workflowInstanceId: 'instance-1',
      },
    },
    {
      name: 'When the event is from a sandbox then should mirror nothing',
      input: { eventType: 'sandbox.ready' },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const logged = captureLogs(store, 'log');

      store.appendEvent(testCase.input);

      assert.equal(logged.at(0)?.level, testCase.wantLevel);
      assert.equal(logged.at(0)?.message, testCase.wantLevel && testCase.input.eventType);
    });
  }
});

describe('Store.listEventsForSandboxRun', () => {
  test('When a run logged events then should return them oldest first', () => {
    store.appendEvent({ eventType: 'sandbox.ready', sandboxRunId });
    rewindFirstEvent(store);
    store.appendEvent({ eventType: 'agent.finished', sandboxRunId });

    assert.deepEqual(
      store.listEventsForSandboxRun(sandboxRunId).map((entry) => entry.eventType),
      ['sandbox.ready', 'agent.finished'],
    );
  });

  test('When another run logged the event then should leave it out', () => {
    store.appendEvent({ eventType: 'tenki.exec', sandboxRunId });

    assert.deepEqual(store.listEventsForSandboxRun('run-404'), []);
  });
});

describe('Store.listEventsForInstance', () => {
  test('When an instance logged events then should return them oldest first', () => {
    store.appendEvent({
      eventType: 'prm.state_changed',
      workflowType: 'pr_maintainer',
      workflowInstanceId: 'instance-1',
    });
    rewindFirstEvent(store);
    store.appendEvent({
      eventType: 'prm.sandbox_started',
      workflowType: 'pr_maintainer',
      workflowInstanceId: 'instance-1',
    });
    store.appendEvent({
      eventType: 'lr.state_changed',
      workflowType: 'log_reviewer',
      workflowInstanceId: 'instance-2',
    });

    assert.deepEqual(
      store.listEventsForInstance('pr_maintainer', 'instance-1').map((entry) => entry.eventType),
      ['prm.state_changed', 'prm.sandbox_started'],
    );
  });

  test('When the instance logged nothing then should return an empty list', () => {
    assert.deepEqual(store.listEventsForInstance('pr_maintainer', 'instance-404'), []);
  });
});

// Events written in the same millisecond tie on created_at, so the first one is
// aged to make the order observable.
function rewindFirstEvent(target: Store): void {
  target.db.exec('UPDATE event_log SET created_at = 1');
}
