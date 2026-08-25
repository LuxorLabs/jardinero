import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type AppConfig, configuredRepositoryNames } from '../config.js';
import { configWithLogReview } from '../testing/config.js';
import { Scheduler } from './scheduler.js';
import { eventually } from '../testing/http.js';
import { captureLogs } from '../testing/logger.js';
import type { Store } from '../store/store.js';
import { createTestStore } from '../testing/store.js';
import { MockWorkerRunner } from './worker/mock-worker.js';
import type { ReapSummary } from '../adapters/tenki/tenki-reaper.js';

describe('Scheduler.start', () => {
  test('When the scheduler starts then should announce a scan immediately', async () => {
    const fixture = createFixture();
    try {
      fixture.config.workflows.prMaintainer.enabled = false;
      fixture.config.store.backupIntervalMin = 0;
      fixture.store.upsertRepository(fixture.config.workflows.logReviewer.repos[0].repo);

      fixture.scheduler.start();

      assert.deepEqual(fixture.scans, ['cron']);
    } finally {
      fixture.cleanup();
    }
  });

  test('When timers are scheduled then should keep them referenced for service mode', async () => {
    const fixture = createFixture({ fetchImpl: emptyPrListFetch });
    try {
      fixture.scheduler.start();

      const internal = fixture.scheduler as unknown as {
        backupInterval?: NodeJS.Timeout;
        logReviewInterval?: NodeJS.Timeout;
        prMaintainPollInterval?: NodeJS.Timeout;
      };
      assert.equal(internal.logReviewInterval?.hasRef(), true);
      assert.equal(internal.prMaintainPollInterval?.hasRef(), true);
      assert.equal(internal.backupInterval?.hasRef(), true);
    } finally {
      fixture.cleanup();
    }
  });

  // A sub-1 interval would arm setInterval with a 0ms (or negative) period that
  // busy-loops the poll; the guards skip arming it instead.
  const disabledIntervalCases: Array<{
    name: string;
    configure(config: AppConfig): void;
    timer: 'prMaintainPollInterval' | 'logReviewInterval';
  }> = [
    {
      name: 'When the pr maintain poll minutes is below one then should not start interval',
      configure(config) {
        config.workflows.logReviewer.enabled = false;
        config.workflows.prMaintainer.pollIntervalMin = 0;
      },
      timer: 'prMaintainPollInterval',
    },
    {
      name: 'When the `log_review` cron minutes is below one then should not start interval',
      configure(config) {
        config.workflows.prMaintainer.enabled = false;
        config.store.backupIntervalMin = 0;
        config.workflows.logReviewer.enabled = true;
        config.workflows.logReviewer.scanIntervalMin = 0;
      },
      timer: 'logReviewInterval',
    },
  ];

  for (const testCase of disabledIntervalCases) {
    test(testCase.name, () => {
      const fixture = createFixture();
      try {
        testCase.configure(fixture.config);
        fixture.scheduler.start();

        const internal = fixture.scheduler as unknown as Record<string, NodeJS.Timeout | undefined>;
        assert.equal(internal[testCase.timer], undefined);
      } finally {
        fixture.cleanup();
      }
    });
  }

  // The startup sweep reclaims sandboxes a crash or restart stranded, so it must
  // fire before the first interval tick rather than one poll period later.
  test('When a reaper is wired then should sweep at startup and arm the interval', async () => {
    let calls = 0;
    const fixture = createFixture({
      fetchImpl: emptyPrListFetch,
      reapSandboxesOnce: async () => {
        calls += 1;
        return emptySummary();
      },
    });
    try {
      // Only the reaper is under test; the other schedules would dispatch real
      // runs this test never awaits, and cleanup() closes the database.
      quietSchedules(fixture.config);
      fixture.scheduler.start();
      await flush();

      assert.equal(calls, 1);
      const internal = fixture.scheduler as unknown as {
        sandboxReaperInterval?: NodeJS.Timeout;
      };
      assert.equal(internal.sandboxReaperInterval?.hasRef(), true);
    } finally {
      fixture.cleanup();
    }
  });

  test('When the sandbox reaper poll minutes is below one then should not start interval', () => {
    const fixture = createFixture({
      reapSandboxesOnce: async () => emptySummary(),
    });
    try {
      quietSchedules(fixture.config);
      fixture.config.worker.sandboxReaperIntervalMin = 0;
      fixture.scheduler.start();

      const internal = fixture.scheduler as unknown as {
        sandboxReaperInterval?: NodeJS.Timeout;
      };
      assert.equal(internal.sandboxReaperInterval, undefined);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('Scheduler.stop', () => {
  test('When every timer is armed then should clear them all', async () => {
    const fixture = createFixture({
      fetchImpl: emptyPrListFetch,
      reapSandboxesOnce: async () => emptySummary(),
    });
    try {
      fixture.scheduler.start();
      await flush();
      fixture.scheduler.stop();

      const internal = fixture.scheduler as unknown as Record<string, NodeJS.Timeout | undefined>;
      for (const timer of [
        'logReviewInterval',
        'backupInterval',
        'prMaintainPollInterval',
        'sandboxReaperInterval',
      ]) {
        assert.equal(internal[timer], undefined, `${timer} should be cleared`);
      }
    } finally {
      fixture.cleanup();
    }
  });
});

describe('Scheduler.runPrMaintenancePollCycle', () => {
  test('When a cycle is in flight then should not overlap', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listCalls = 0;
    const fixture = createFixture({
      fetchImpl: async (input) => {
        if (!String(input).includes('/pulls?')) return emptyJson('{"data":{}}');
        listCalls += 1;
        await gate;
        return emptyJson('[]');
      },
    });
    const repoCount = configuredRepositoryNames(fixture.config).length;
    try {
      fixture.scheduler.runPrMaintenancePollCycle();
      fixture.scheduler.runPrMaintenancePollCycle();
      await flush();
      assert.equal(listCalls, repoCount, 'the second cycle finds the first still in flight');

      release();
      await flush();
      fixture.scheduler.runPrMaintenancePollCycle();
      await flush();
      assert.equal(listCalls, repoCount * 2);
    } finally {
      release();
      fixture.cleanup();
    }
  });

  // The reconcile call sits before the poll's in-flight guard on purpose, so a
  // poll cycle that outlives its interval never starves merge reconciliation.

  test('When a repository cannot be listed then should record why', async () => {
    const fixture = createFixture({
      fetchImpl: async () => {
        throw new Error('github unreachable');
      },
    });
    try {
      fixture.scheduler.runPrMaintenancePollCycle();

      await eventually(() => {
        assert.ok(readEvents(fixture.store, 'orchestrator.pull_request_sweep_failed').length > 0);
      });
    } finally {
      fixture.cleanup();
    }
  });
});

describe('Scheduler.runSandboxReaper', () => {
  test('When a reaper is wired then should invoke it', async () => {
    let calls = 0;
    const fixture = createFixture({
      reapSandboxesOnce: async () => {
        calls += 1;
        return emptySummary();
      },
    });
    try {
      fixture.scheduler.runSandboxReaper('startup');
      await flush();
      assert.equal(calls, 1);
    } finally {
      fixture.cleanup();
    }
  });

  test('When a cycle is in flight then should not overlap', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture({
      reapSandboxesOnce: async () => {
        calls += 1;
        await gate;
        return emptySummary();
      },
    });
    try {
      fixture.scheduler.runSandboxReaper('interval');
      fixture.scheduler.runSandboxReaper('interval');
      await flush();
      // The second call is dropped by the in-flight guard while the first is pending.
      assert.equal(calls, 1);

      release();
      await flush();
      // Once the first cycle settles the guard clears and a fresh call runs.
      fixture.scheduler.runSandboxReaper('interval');
      await flush();
      assert.equal(calls, 2);
    } finally {
      fixture.cleanup();
    }
  });

  test('When a sweep reaps or fails then should narrate the cycle', async () => {
    const fixture = createFixture({
      reapSandboxesOnce: async () => ({ ...emptySummary(), listed: 2, reaped: 1, failed: 1 }),
    });
    const logs = captureLogs(fixture.scheduler);
    try {
      fixture.scheduler.runSandboxReaper('interval');
      await flush();

      const complete = logs.find((event) => event.message === 'sandbox reaper complete');
      assert.ok(complete);
      assert.equal(complete.fields?.reason, 'interval');
      assert.equal(complete.fields?.reaped, 1);
      assert.equal(complete.fields?.failed, 1);
    } finally {
      fixture.cleanup();
    }
  });

  test('When no reaper is wired then should stay disabled', async () => {
    const fixture = createFixture();
    try {
      // Neither the startup tick nor a manual call should throw when disabled.
      fixture.scheduler.start();
      fixture.scheduler.runSandboxReaper('startup');
      await flush();
    } finally {
      fixture.cleanup();
    }
  });

  test('When the cycle and its audit both fail then should not leak a rejection', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    let calls = 0;
    const fixture = createFixture({
      reapSandboxesOnce: async () => {
        calls += 1;
        throw new Error('reap cycle failed');
      },
    });
    try {
      // The handler's own record of the failure throws too; it must swallow that rather
      // than let it escape as an unhandled rejection that trips the fail-fast exit.
      fixture.store.appendEvent = () => {
        throw new Error('the database is gone');
      };

      fixture.scheduler.runSandboxReaper('interval');
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(calls, 1);
      assert.deepEqual(rejections, []);

      // The in-flight guard is cleared even when both the cycle and its audit fail,
      // so a later tick still runs.
      fixture.scheduler.runSandboxReaper('interval');
      await flush();
      assert.equal(calls, 2);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      fixture.cleanup();
    }
  });
});

function createFixture(
  options: { fetchImpl?: typeof fetch; reapSandboxesOnce?: () => Promise<ReapSummary> } = {},
) {
  const { store, dataPath: tempDir, cleanup: closeStore } = createTestStore();
  const config = configWithLogReview();
  config.store.dataPath = tempDir;
  config.worker.runner = 'mock';
  config.sandboxes.maxConcurrentRuns = 1;
  config.workflows.prMaintainer.maxConcurrentRuns = 1;

  const runner = new MockWorkerRunner();
  const scans: string[] = [];
  const discovered: number[] = [];
  const scheduler = new Scheduler(config, {
    store,
    orchestrator: recordingMachines(discovered),
    commands: recordingCommands(scans),
    env: { [config.worker.githubTokenEnv]: 'tok' },
    fetchImpl: options.fetchImpl,
    reapSandboxesOnce: options.reapSandboxesOnce,
  });

  return {
    config,
    store,
    runner,
    scheduler,
    scans,
    discovered,
    cleanup() {
      scheduler.stop();
      closeStore();
    },
  };
}

function quietSchedules(config: AppConfig): void {
  config.workflows.logReviewer.enabled = false;
  config.workflows.prMaintainer.enabled = false;
  config.store.backupIntervalMin = 0;
}

const emptyPrListFetch: typeof fetch = async () => emptyJson('[]');

function emptyJson(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

function emptySummary(): ReapSummary {
  return {
    listed: 0,
    reaped: 0,
    failed: 0,
    byClass: {
      reap_terminal_run: 0,
      skip_foreign: 0,
      skip_terminal_state: 0,
      skip_active_run: 0,
      skip_unowned_run: 0,
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

// recordingMachines records what the clock announced, which is what these suites
// assert; what a machine does with a time event is covered where it lives.
function recordingMachines(discovered: number[]) {
  return {
    prMaintainer: {
      onPrDiscovered: (ref: { pullRequestNumber: number }) => {
        discovered.push(ref.pullRequestNumber);
        return Promise.resolve(undefined);
      },
    },
  } as unknown as ConstructorParameters<typeof Scheduler>[1]['orchestrator'];
}

function recordingCommands(
  scans: string[],
): ConstructorParameters<typeof Scheduler>[1]['commands'] {
  return {
    announceLogReview: (scope) => {
      scans.push(scope.askedBy ?? '');
      return Promise.resolve({ announced: scans.slice(), unknownRepositories: [] });
    },
  };
}

function readEvents(store: Store, eventType: string): unknown[] {
  return store.queryReadOnly('SELECT id FROM event_log WHERE event_type = ?', [eventType]);
}
