import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { FinishSandboxRunInput, Store } from './store.js';
import type { SandboxRunState, SandboxRun, WorkflowType } from './types.js';
import { type StoreFixture, createTestStore } from '../testing/store.js';

let fixture: StoreFixture;
let store: Store;

beforeEach(() => {
  fixture = createTestStore();
  store = fixture.store;
});

afterEach(() => {
  fixture.cleanup();
});

describe('Store.startSandboxRun', () => {
  test('When a run starts then should open it pending with no result yet', () => {
    const run = start();

    assert.equal(run.runState, 'pending');
    assert.equal(run.agentName, 'pr-maintainer');
    assert.equal(run.workflowType, 'pr_maintainer');
    assert.equal(run.workflowInstanceId, 'instance-1');
    assert.equal(run.sandboxSessionId, null);
    assert.equal(run.costUsd, null);
    assert.equal(run.errorMessage, null);
    assert.equal(run.endedAt, null);
  });
});

describe('Store.getSandboxRun', () => {
  const cases: Array<{ name: string; id(storedId: string): string; wantFound: boolean }> = [
    {
      name: 'When the id is known then should return the run',
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
      const stored = start();

      const found = store.getSandboxRun(testCase.id(stored.id));

      assert.deepEqual(found, testCase.wantFound ? stored : undefined);
    });
  }
});

describe('Store.markSandboxRunRunning', () => {
  // The session id arrives with the first sandbox event, so a later call that does
  // not carry it must not erase it.
  const cases: Array<{
    name: string;
    sandboxSessionId?: string;
    wantSandboxSessionId: string | null;
  }> = [
    {
      name: 'When a session id is given then should store it',
      sandboxSessionId: 'session-1',
      wantSandboxSessionId: 'session-1',
    },
    {
      name: 'When no session id is given then should keep the stored one',
      wantSandboxSessionId: 'session-0',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const run = start();
      store.markSandboxRunRunning(run.id, 'session-0');

      store.markSandboxRunRunning(run.id, testCase.sandboxSessionId);

      const stored = store.getSandboxRun(run.id);
      assert.equal(stored?.runState, 'running');
      assert.equal(stored?.sandboxSessionId, testCase.wantSandboxSessionId);
    });
  }
});

describe('Store.finishSandboxRun', () => {
  const cases: Array<{ name: string; input: FinishSandboxRunInput; want: Partial<SandboxRun> }> = [
    {
      name: 'When the run succeeded then should store its cost',
      input: { runState: 'succeeded', costUsd: 0.42, sandboxSessionId: 'session-1' },
      want: {
        runState: 'succeeded',
        costUsd: 0.42,
        sandboxSessionId: 'session-1',
        errorMessage: null,
      },
    },
    {
      name: 'When the run failed then should store the reason',
      input: { runState: 'failed', errorMessage: 'sandbox exploded' },
      want: { runState: 'failed', errorMessage: 'sandbox exploded' },
    },
    {
      // An unknown cost is not a free run, so it stays empty instead of becoming zero.
      name: 'When the cost is unknown then should leave it empty',
      input: { runState: 'aborted' },
      want: { runState: 'aborted', costUsd: null },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const run = start();

      store.finishSandboxRun(run.id, testCase.input);

      const stored = store.getSandboxRun(run.id) as SandboxRun;
      assert.notEqual(stored.endedAt, null);
      for (const [field, value] of Object.entries(testCase.want)) {
        assert.equal(stored[field as keyof SandboxRun], value, field);
      }
    });
  }

  test('When the session id is omitted then should keep the stored one', () => {
    const run = start();
    store.markSandboxRunRunning(run.id, 'session-0');

    store.finishSandboxRun(run.id, { runState: 'succeeded' });

    assert.equal(store.getSandboxRun(run.id)?.sandboxSessionId, 'session-0');
  });
});

describe('Store.listSandboxRuns', () => {
  const cases: Array<{
    name: string;
    limit?: number;
    runState?: SandboxRunState;
    wantCount: number;
  }> = [
    { name: 'When no state is given then should return every run', wantCount: 3 },
    {
      name: 'When a state is given then should return only its runs',
      runState: 'succeeded',
      wantCount: 1,
    },
    { name: 'When a limit is given then should return at most that many', limit: 2, wantCount: 2 },
    {
      name: 'When no run is in that state then should return an empty list',
      runState: 'orphaned',
      wantCount: 0,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const succeeded = start();
      store.finishSandboxRun(succeeded.id, { runState: 'succeeded' });
      const failed = start();
      store.finishSandboxRun(failed.id, { runState: 'failed' });
      start();

      const runs = store.listSandboxRuns(testCase.limit, testCase.runState);

      assert.equal(runs.length, testCase.wantCount);
    });
  }

  test('When several runs exist then should return the newest first', () => {
    const older = start();
    store.db.prepare('UPDATE sandbox_run SET started_at = 1 WHERE id = ?').run(older.id);
    const newer = start();

    assert.deepEqual(
      store.listSandboxRuns().map((run) => run.id),
      [newer.id, older.id],
    );
  });
});

describe('Store.countRunningSandboxRuns', () => {
  // Concurrency is capped on what is in flight, and a queued run holds a slot as
  // much as a started one.
  const cases: Array<{ name: string; runState?: SandboxRunState; wantCounted: boolean }> = [
    { name: 'When a run is pending then should count it', wantCounted: true },
    { name: 'When a run is running then should count it', runState: 'running', wantCounted: true },
    {
      name: 'When a run succeeded then should not count it',
      runState: 'succeeded',
      wantCounted: false,
    },
    { name: 'When a run failed then should not count it', runState: 'failed', wantCounted: false },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const run = start();
      if (testCase.runState === 'running') store.markSandboxRunRunning(run.id);
      if (testCase.runState === 'succeeded' || testCase.runState === 'failed') {
        store.finishSandboxRun(run.id, { runState: testCase.runState });
      }

      assert.equal(store.countRunningSandboxRuns(), testCase.wantCounted ? 1 : 0);
    });
  }
});

describe('Store.countSandboxRunsByWorkflowAndState', () => {
  test('When runs exist then should count them per workflow and state', () => {
    const succeeded = start();
    store.finishSandboxRun(succeeded.id, { runState: 'succeeded' });
    start();
    start({ workflowType: 'log_reviewer' });

    const counts = store.countSandboxRunsByWorkflowAndState();

    assert.deepEqual(counts, [
      { workflowType: 'log_reviewer', runState: 'pending', count: 1 },
      { workflowType: 'pr_maintainer', runState: 'pending', count: 1 },
      { workflowType: 'pr_maintainer', runState: 'succeeded', count: 1 },
    ]);
  });

  test('When there are no runs then should return an empty list', () => {
    assert.deepEqual(store.countSandboxRunsByWorkflowAndState(), []);
  });
});

describe('Store.listSandboxRunsForInstance', () => {
  test('When an instance ran twice then should return its runs oldest first', () => {
    const first = start();
    store.db.prepare('UPDATE sandbox_run SET started_at = 1 WHERE id = ?').run(first.id);
    const second = start();
    start({ workflowInstanceId: 'instance-2' });

    const runs = store.listSandboxRunsForInstance('pr_maintainer', 'instance-1');

    assert.deepEqual(
      runs.map((run) => run.id),
      [first.id, second.id],
    );
  });

  test('When the instance never ran then should return an empty list', () => {
    assert.deepEqual(store.listSandboxRunsForInstance('pr_maintainer', 'instance-404'), []);
  });
});

describe('Store.initializeAfterBoot', () => {
  const cases: Array<{ name: string; runState: SandboxRunState; wantOrphaned: boolean }> = [
    {
      name: 'When a run was still pending then should orphan it',
      runState: 'pending',
      wantOrphaned: true,
    },
    {
      // Nothing will ever report on a run whose process is gone, so the machine
      // waiting on it would wait forever.
      name: 'When a run was still running then should orphan it',
      runState: 'running',
      wantOrphaned: true,
    },
    {
      name: 'When a run already succeeded then should leave it alone',
      runState: 'succeeded',
      wantOrphaned: false,
    },
    {
      name: 'When a run already failed then should leave it alone',
      runState: 'failed',
      wantOrphaned: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const run = start();
      if (testCase.runState === 'running') store.markSandboxRunRunning(run.id);
      if (testCase.runState === 'succeeded' || testCase.runState === 'failed') {
        store.finishSandboxRun(run.id, { runState: testCase.runState });
      }

      store.initializeAfterBoot();

      const stored = store.getSandboxRun(run.id);
      assert.equal(stored?.runState, testCase.wantOrphaned ? 'orphaned' : testCase.runState);
      assert.equal(
        stored?.errorMessage,
        testCase.wantOrphaned ? 'orchestrator restarted while run was in flight' : null,
      );
    });
  }

  test('When nothing was in flight then should not audit a recovery', () => {
    store.initializeAfterBoot();

    assert.equal(recordedOrphanEvents(store), 0);
  });

  test('When runs were in flight then should audit how many were orphaned', () => {
    start();
    start();

    store.initializeAfterBoot();

    assert.equal(recordedOrphanEvents(store), 1);
  });
});

function start(
  fields: { workflowType?: WorkflowType; workflowInstanceId?: string } = {},
): SandboxRun {
  return store.startSandboxRun({
    agentName: 'pr-maintainer',
    workflowType: fields.workflowType ?? 'pr_maintainer',
    workflowInstanceId: fields.workflowInstanceId ?? 'instance-1',
  });
}

function recordedOrphanEvents(target: Store): number {
  return target.queryReadOnly('SELECT id FROM event_log WHERE event_type = ?', [
    'orchestrator.runs_left_by_dead_process',
  ]).length;
}
