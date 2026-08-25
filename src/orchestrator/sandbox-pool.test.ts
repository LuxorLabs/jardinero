import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../store/store.js';
import type { SandboxRun, WorkflowType } from '../store/types.js';
import { captureLogs } from '../testing/logger.js';
import { createTestStore } from '../testing/store.js';
import type { WorkerResult } from '../types.js';
import {
  SandboxPool,
  type SandboxRunContext,
  type SandboxRunner,
  type SandboxRunOutcomeReporter,
  type SandboxTask,
  type SandboxTaskFactory,
} from './sandbox-pool.js';

let store: Store;
let cleanup: () => void;
let runner: FakeRunner;
let reporter: FakeReporter;
let tasks: FakeTaskFactory;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  runner = new FakeRunner();
  reporter = new FakeReporter();
  tasks = new FakeTaskFactory();
});

afterEach(() => {
  cleanup();
});

describe('SandboxPool.startSandbox', () => {
  const cases: StartCase[] = [
    {
      name: 'When there is room then should start the sandbox',
      want: { started: true, executed: 1 },
    },
    {
      // No queue here on purpose: the run stays in its *_pending state and the
      // periodic check asks again.
      name: 'When the global cap is full then should refuse without starting anything',
      arrange: () => {
        config.maxConcurrentSandboxes = 0;
      },
      want: { started: false, executed: 0 },
    },
    {
      name: 'When the cap for that workflow is full then should refuse',
      arrange: () => {
        config.maxConcurrentSandboxesByWorkflow = { pr_maintainer: 0 };
      },
      want: { started: false, executed: 0 },
    },
    {
      name: 'When another workflow has a cap then should not count it against this one',
      arrange: () => {
        config.maxConcurrentSandboxesByWorkflow = { log_reviewer: 0 };
      },
      want: { started: true, executed: 1 },
    },
    {
      name: 'When the pool is stopping then should refuse',
      arrange: (_sandboxRunId, pool) => {
        void pool.stop();
      },
      want: { started: false, executed: 0 },
    },
    {
      name: 'When the run row is gone then should refuse',
      arrange: (sandboxRunId) => {
        store.db.prepare('DELETE FROM sandbox_run WHERE id = ?').run(sandboxRunId);
      },
      want: { started: false, executed: 0 },
    },
    {
      name: 'When the sandbox is already executing then should answer started without starting again',
      arrange: (sandboxRunId, pool) => {
        runner.blockUntilReleased = true;
        pool.startSandbox(sandboxRunId);
      },
      want: { started: true, executed: 1 },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const pool = createPool();
      const sandboxRun = startSandboxRun();
      c.arrange?.(sandboxRun.id, pool);

      const started = pool.startSandbox(sandboxRun.id);

      await flush();
      assert.equal(started, c.want.started);
      assert.equal(runner.contexts.length, c.want.executed);
    });
  }
});

describe('SandboxPool.hasRoomFor', () => {
  const cases: RoomCase[] = [
    { name: 'When nothing is running then should answer there is room', want: true },
    {
      name: 'When the global cap is full then should answer there is none',
      arrange: () => {
        config.maxConcurrentSandboxes = 0;
      },
      want: false,
    },
    {
      name: 'When this workflow is at its cap then should answer there is none',
      arrange: (pool) => {
        config.maxConcurrentSandboxesByWorkflow = { pr_maintainer: 1 };
        pool.startSandbox(startSandboxRun().id);
      },
      want: false,
    },
    {
      name: 'When another workflow holds the sandboxes then should not count them',
      arrange: (pool) => {
        config.maxConcurrentSandboxesByWorkflow = { pr_maintainer: 1 };
        pool.startSandbox(startSandboxRun('log_reviewer').id);
      },
      want: true,
    },
    {
      name: 'When the pool is stopping then should answer there is none',
      arrange: (pool) => {
        void pool.stop();
      },
      want: false,
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const pool = createPool();
      runner.blockUntilReleased = true;
      c.arrange?.(pool);
      // The runner listens for the abort on its first turn, so stop() can only end a
      // blocked sandbox once it has had one.
      await flush();

      assert.equal(pool.hasRoomFor('pr_maintainer'), c.want);
      await pool.stop();
    });
  }
});

describe('SandboxPool.isExecuting', () => {
  const cases: ExecutingCase[] = [
    {
      // The row can say `running` and this can say no, which is how a sandbox
      // that died with the process is told apart from one that is working.
      name: 'When the sandbox is running then should answer that this process has it',
      blockRunner: true,
      want: { executing: true },
    },
    {
      name: 'When the sandbox finished then should answer that this process no longer has it',
      want: { executing: false },
    },
    {
      name: 'When the run was never started then should answer that this process does not have it',
      skipStart: true,
      want: { executing: false },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const pool = createPool();
      const sandboxRun = startSandboxRun();
      runner.blockUntilReleased = c.blockRunner ?? false;
      if (!c.skipStart) pool.startSandbox(sandboxRun.id);

      await flush();

      assert.equal(pool.isExecuting(sandboxRun.id), c.want.executing);
      runner.release();
    });
  }
});

describe('SandboxPool.abort', () => {
  // Whether the runner answers "aborted" or dies on the cancellation, the run is ours to
  // explain: the platform error the cancellation leaves behind would send whoever reads the
  // run to the wrong system.
  const cases: Array<{ name: string; throwOnAbort?: Error }> = [
    {
      name: 'When the runner answers the abort then should record the abort as ours',
    },
    {
      name: 'When the abort makes the runner throw then should record the abort as ours',
      throwOnAbort: new Error('[unavailable] failed to dispatch command to node-agent'),
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const pool = createPool();
      const sandboxRun = startSandboxRun();
      runner.blockUntilReleased = true;
      runner.throwOnAbort = c.throwOnAbort;
      pool.startSandbox(sandboxRun.id);
      await flush();

      pool.abort(sandboxRun.id);
      await flush();

      assert.equal(runner.contexts[0].signal.aborted, true);
      const stored = store.getSandboxRun(sandboxRun.id);
      assert.equal(stored?.runState, 'aborted');
      assert.equal(stored?.errorMessage, 'run aborted by the orchestrator');
      assert.deepEqual(reporter.failed, []);
      assert.equal(pool.isExecuting(sandboxRun.id), false);
    });
  }

  test('When the run is not executing here then should do nothing', () => {
    const pool = createPool();

    assert.doesNotThrow(() => pool.abort('missing'));
  });
});

describe('SandboxPool run outcomes', () => {
  const cases: OutcomeCase[] = [
    {
      name: 'When the agent succeeded then should record the run and report it succeeded',
      result: { status: 'succeeded', costUsd: 1.5, summary: 'done', sandboxSessionId: 'session-1' },
      want: { runState: 'succeeded', costUsd: 1.5, reportedSucceeded: 1 },
    },
    {
      name: 'When the agent failed then should record the run and report it failed',
      result: { status: 'failed', costUsd: null, summary: 'boom', error: 'boom' },
      want: { runState: 'failed', errorMessage: 'boom', reportedFailed: 1 },
    },
    {
      // An unknown cost is null and never zero, so a missing cost does not read
      // as a free run when the budget is checked.
      name: 'When the cost is unknown then should record it as null',
      result: { status: 'succeeded', costUsd: null, summary: 'done' },
      want: { runState: 'succeeded', reportedSucceeded: 1 },
    },
    {
      name: 'When the agent answered without a pull request then should report it as an outcome',
      result: { status: 'skipped', costUsd: null, summary: 'no fix warranted' },
      want: { runState: 'skipped', reportedSucceeded: 1 },
    },
    {
      name: 'When the runner threw then should record the run failed and report it',
      throws: true,
      want: { runState: 'failed', errorMessage: 'the sandbox blew up', reportedFailed: 1 },
    },
    {
      // The instance already moved on, so telling it would move it again.
      name: 'When the run was aborted then should record it without reporting an outcome',
      result: { status: 'aborted', costUsd: null, summary: 'stopped' },
      want: { runState: 'aborted', errorMessage: 'run aborted by the orchestrator' },
    },
    {
      name: 'When the abort closed the run stream then should record the abort as ours',
      result: {
        status: 'aborted',
        costUsd: null,
        summary: 'stopped',
        error: 'sandbox run stream closed before exit',
      },
      want: { runState: 'aborted', errorMessage: 'run aborted by the orchestrator' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const pool = createPool();
      const sandboxRun = startSandboxRun();
      if (c.result) runner.result = c.result;
      runner.throws = c.throws ?? false;

      pool.startSandbox(sandboxRun.id);
      await flush();

      const stored = store.getSandboxRun(sandboxRun.id);
      assert.equal(stored?.runState, c.want.runState);
      assert.equal(stored?.costUsd, c.want.costUsd ?? null);
      assert.equal(stored?.errorMessage, c.want.errorMessage ?? null);
      assert.equal(reporter.succeeded.length, c.want.reportedSucceeded ?? 0);
      assert.equal(reporter.failed.length, c.want.reportedFailed ?? 0);
      assert.equal(pool.isExecuting(sandboxRun.id), false);
    });
  }
});

describe('SandboxPool while executing', () => {
  test('When the agent starts then should mark the run running before handing it over', async () => {
    const pool = createPool();
    const sandboxRun = startSandboxRun();
    runner.blockUntilReleased = true;

    pool.startSandbox(sandboxRun.id);
    await flush();

    assert.equal(store.getSandboxRun(sandboxRun.id)?.runState, 'running');
    runner.release();
  });

  test('When the agent publishes an event then should append it to the logbook', async () => {
    const pool = createPool();
    const sandboxRun = startSandboxRun();
    runner.publish = { type: 'tenki.started', data: { step: 1 } };

    pool.startSandbox(sandboxRun.id);
    await flush();

    const [entry] = store.listEventsForInstance('pr_maintainer', 'instance-1');
    assert.equal(entry.eventType, 'tenki.started');
    assert.equal(entry.sandboxRunId, sandboxRun.id);
  });

  // Reporting reaches a state machine, and its failure must not take down the
  // pool: the periodic check finds the finished run and moves the instance.
  test('When reporting the outcome throws then should still finish the run', async () => {
    const pool = createPool();
    const sandboxRun = startSandboxRun();
    reporter.throws = true;

    pool.startSandbox(sandboxRun.id);
    await flush();

    assert.equal(store.getSandboxRun(sandboxRun.id)?.runState, 'succeeded');
    assert.equal(pool.isExecuting(sandboxRun.id), false);
  });

  test('When building the task fails then should record the run failed', async () => {
    const pool = createPool();
    const sandboxRun = startSandboxRun();
    tasks.throws = true;

    pool.startSandbox(sandboxRun.id);
    await flush();

    assert.equal(store.getSandboxRun(sandboxRun.id)?.runState, 'failed');
    assert.equal(runner.contexts.length, 0);
  });
});

describe('SandboxPool context', () => {
  const cases: Array<{ name: string; read(context: SandboxRunContext): unknown; want: unknown }> = [
    {
      name: 'When a sandbox runs then should hand the agent the run it is for',
      read: (context) => context.sandboxRun.agentName,
      want: 'PrMaintainer',
    },
    {
      name: 'When a sandbox runs then should hand the agent its task',
      read: (context) => context.task.workflow,
      want: 'pr_maintain',
    },
    {
      name: 'When a sandbox runs then should hand the agent how long it may take',
      read: (context) => context.maxWallClockMs,
      want: 60_000,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const pool = createPool();
      const sandboxRun = startSandboxRun();

      pool.startSandbox(sandboxRun.id);
      await flush();

      assert.equal(testCase.read(runner.contexts[0]), testCase.want);
    });
  }

  test('When the agent writes an artifact then should store it under its run', async () => {
    const pool = createPool();
    const sandboxRun = startSandboxRun();

    pool.startSandbox(sandboxRun.id);
    await flush();
    await runner.contexts[0].writeSandboxRunArtifact('summary.md', 'done');

    assert.equal(
      store.readSandboxRunArtifact(sandboxRun.id, 'summary.md')?.content.toString(),
      'done',
    );
  });
});

describe('SandboxPool.recordWorkerEvent', () => {
  const cases: WorkerEventCase[] = [
    {
      name: 'When the run is known then should write the event down against its instance',
      event: { type: 'worker.log', message: 'building', data: { step: 'install' } },
      want: { recorded: ['worker.log'], sandboxSessionId: null },
    },
    {
      // The row has to point at its sandbox as soon as there is one: a run that never
      // completes still has to be reclaimable.
      name: 'When the session became ready then should record the sandbox it runs in',
      event: { type: 'sandbox.ready', data: { sandbox_session_id: 'sess-1' } },
      want: { recorded: ['sandbox.ready'], sandboxSessionId: 'sess-1' },
    },
    {
      name: 'When the ready event names no sandbox then should leave the row alone',
      event: { type: 'sandbox.ready', data: {} },
      want: { recorded: ['sandbox.ready'], sandboxSessionId: null },
    },
    {
      name: 'When the session start is being retried then should write it down too',
      event: { type: 'sandbox.create_retried', data: { attempt: 2 } },
      want: { recorded: ['sandbox.create_retried'], sandboxSessionId: null },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const pool = createPool();
      const sandboxRun = startSandboxRun();

      pool.recordWorkerEvent(sandboxRun.id, c.event);

      const recorded = store.listEventsForInstance('pr_maintainer', 'instance-1');
      assert.deepEqual(
        recorded.map((entry) => entry.eventType),
        c.want.recorded,
      );
      assert.equal(recorded.at(0)?.sandboxRunId, sandboxRun.id);
      assert.equal(store.getSandboxRun(sandboxRun.id)?.sandboxSessionId, c.want.sandboxSessionId);
    });
  }

  test('When the run is unknown then should write nothing down', () => {
    const pool = createPool();

    pool.recordWorkerEvent('00000000-0000-4000-8000-000000000000', { type: 'worker.log' });

    assert.deepEqual(store.listEventsForInstance('pr_maintainer', 'instance-1'), []);
  });

  // codex.* fires once per streamed CLI line, so it must not flood the terminal, and a
  // failure must not hide at debug.
  const logCases: LogLevelCase[] = [
    {
      name: 'When the event is a failure then should log it at warn',
      type: 'tenki.setup_failed',
      want: 'warn',
    },
    {
      name: 'When the event is codex output then should log it at debug',
      type: 'agent.turn.started',
      want: 'debug',
    },
    {
      name: 'When the event is anything else then should log it at info',
      type: 'sandbox.ready',
      want: 'info',
    },
  ];

  for (const c of logCases) {
    test(c.name, () => {
      const pool = createPool();
      const sandboxRun = startSandboxRun();
      const logs = captureLogs(pool, 'workerLog');

      pool.recordWorkerEvent(sandboxRun.id, { type: c.type });

      assert.equal(logs.at(0)?.level, c.want);
      assert.equal(logs.at(0)?.message, c.type);
    });
  }
});

describe('SandboxPool.stop', () => {
  test('When a run is in flight then should abort it and wait for it to record how it ended', async () => {
    const pool = createPool();
    const sandboxRun = startSandboxRun();
    runner.blockUntilReleased = true;
    pool.startSandbox(sandboxRun.id);
    await Promise.resolve();

    await pool.stop();

    assert.equal(pool.isExecuting(sandboxRun.id), false);
    assert.equal(store.getSandboxRun(sandboxRun.id)?.runState, 'orphaned');
  });

  test('When nothing is in flight then should answer at once', async () => {
    const pool = createPool();

    await pool.stop();

    assert.deepEqual(reporter.succeeded, []);
  });
});

let config: {
  maxConcurrentSandboxes: number;
  maxWallClockMs: number;
  maxConcurrentSandboxesByWorkflow: Partial<Record<WorkflowType, number>>;
};

function createPool(): SandboxPool {
  config = {
    maxConcurrentSandboxes: 4,
    maxWallClockMs: 60_000,
    maxConcurrentSandboxesByWorkflow: {},
  };
  return new SandboxPool(store, runner, tasks, reporter, config);
}

function startSandboxRun(workflowType: WorkflowType = 'pr_maintainer'): SandboxRun {
  return store.startSandboxRun({
    agentName: 'PrMaintainer',
    workflowType,
    workflowInstanceId: 'instance-1',
  });
}

// The pool fires the execution without awaiting it, so a test has to let the
// microtask queue drain before looking at what it did.
async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

class FakeTaskFactory implements SandboxTaskFactory {
  throws = false;

  buildTask(): Promise<SandboxTask> {
    if (this.throws) return Promise.reject(new Error('cannot build the task'));
    return Promise.resolve({
      workflow: 'pr_maintain',
      payload: { repo: 'acme/web.app' },
      promptOverrides: {},
    });
  }
}

class FakeRunner implements SandboxRunner {
  readonly contexts: SandboxRunContext[] = [];
  result: WorkerResult = { status: 'succeeded', costUsd: null, summary: 'done' };
  throws = false;
  throwOnAbort: Error | undefined;
  blockUntilReleased = false;
  publish: { type: string; data?: Record<string, unknown> } | undefined;
  private releaseRunner: (() => void) | undefined;

  async run(context: SandboxRunContext): Promise<WorkerResult> {
    this.contexts.push(context);
    if (this.publish) await context.publishEvent(this.publish);
    if (this.throws) throw new Error('the sandbox blew up');
    if (this.blockUntilReleased) {
      await new Promise<void>((resolve) => {
        this.releaseRunner = resolve;
        context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (context.signal.aborted) {
        if (this.throwOnAbort) throw this.throwOnAbort;
        return { status: 'aborted', costUsd: null, summary: 'aborted' };
      }
    }
    return this.result;
  }

  release(): void {
    this.releaseRunner?.();
  }
}

class FakeReporter implements SandboxRunOutcomeReporter {
  readonly succeeded: string[] = [];
  readonly failed: string[] = [];
  throws = false;

  reportSucceeded(sandboxRunId: string): Promise<void> {
    if (this.throws) return Promise.reject(new Error('the machine refused it'));
    this.succeeded.push(sandboxRunId);
    return Promise.resolve();
  }

  reportFailed(sandboxRunId: string): Promise<void> {
    if (this.throws) return Promise.reject(new Error('the machine refused it'));
    this.failed.push(sandboxRunId);
    return Promise.resolve();
  }
}

interface StartCase {
  name: string;
  arrange?: (sandboxRunId: string, pool: SandboxPool) => void;
  want: { started: boolean; executed: number };
}

interface RoomCase {
  name: string;
  arrange?: (pool: SandboxPool) => void;
  want: boolean;
}

interface ExecutingCase {
  name: string;
  blockRunner?: boolean;
  skipStart?: boolean;
  want: { executing: boolean };
}

interface OutcomeCase {
  name: string;
  result?: WorkerResult;
  throws?: boolean;
  want: {
    runState: string;
    costUsd?: number;
    errorMessage?: string;
    reportedSucceeded?: number;
    reportedFailed?: number;
  };
}

interface WorkerEventCase {
  name: string;
  event: { type: string; message?: string; data?: Record<string, unknown> };
  want: { recorded: string[]; sandboxSessionId: string | null };
}

interface LogLevelCase {
  name: string;
  type: string;
  want: 'debug' | 'info' | 'warn';
}
