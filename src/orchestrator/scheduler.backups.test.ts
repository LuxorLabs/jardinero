import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { loadConfig } from '../config.js';
import { Scheduler } from './scheduler.js';
import { eventually } from '../testing/http.js';
import { captureLogs } from '../testing/logger.js';

describe('Scheduler.start', () => {
  test('When backups start then should create startup backup before interval', async () => {
    const fixture = createBackupSchedulerFixture();
    try {
      fixture.scheduler.start();

      await eventually(() => {
        assert.equal(fixture.getBackupCalls(), 1);
        assert.equal(fixture.getPruneCalls(), 1);
      });
      const internal = fixture.scheduler as unknown as { backupInterval?: NodeJS.Timeout };
      assert.equal(internal.backupInterval?.hasRef(), true);
    } finally {
      fixture.scheduler.stop();
    }
  });
});

describe('Scheduler.runBackupCycle', () => {
  const SQLITE_DIR = path.join(tmpdir(), 'jardinero-backup-context');
  const SQLITE_TARGET = path.join(SQLITE_DIR, 'state-failed.db');
  const NON_ERROR_DIR = path.join(tmpdir(), 'jardinero-backup-non-error');

  // A failed backup is only debuggable from its log line, so each row pins the
  // fields an operator needs to act on it.
  const failureCases: Array<{
    name: string;
    reason: 'interval' | 'retry';
    arrange(): ReturnType<typeof createBackupSchedulerFixture>;
    wantFields: Record<string, unknown>;
    wantBackupCalls?: number;
  }> = [
    {
      name: 'When the backup fails with a sqlite error then should log its context and retry once',
      reason: 'interval',
      arrange: () =>
        createBackupSchedulerFixture({
          backupRetryDelayMs: 1,
          backupNow: failingBackup(sqliteBackupError, path.join(SQLITE_DIR, 'state-ok.db')),
        }),
      wantFields: {
        reason: 'interval',
        retry_scheduled: true,
        error: 'not an error',
        error_name: 'SqliteError',
        error_type: 'object',
        error_code: 'SQLITE_BUSY',
        backup_dir: SQLITE_DIR,
        target_path: SQLITE_TARGET,
        partial_target_removed: false,
        partial_target_removal_code: 'EACCES',
      },
      wantBackupCalls: 2,
    },
    {
      // A rejection that is not an Error still has to name a directory, which only
      // the store can supply, and a retry cycle never schedules another retry.
      name: 'When the backup rejects a non error then should log the actionable fields anyway',
      reason: 'retry',
      arrange: () => {
        const fixture = createBackupSchedulerFixture({
          backupNow: async () => {
            throw 'not an error';
          },
        });
        (fixture.scheduler as unknown as { store: { backupsDir: string } }).store.backupsDir =
          NON_ERROR_DIR;
        return fixture;
      },
      wantFields: {
        reason: 'retry',
        retry_scheduled: false,
        error: 'not an error',
        error_name: 'string',
        error_type: 'string',
        backup_dir: NON_ERROR_DIR,
        target_path: undefined,
      },
    },
  ];

  for (const testCase of failureCases) {
    test(testCase.name, async () => {
      const fixture = testCase.arrange();
      const logs = captureLogs(fixture.scheduler);
      try {
        await fixture.scheduler.runBackupCycle(testCase.reason);

        if (testCase.wantBackupCalls !== undefined) {
          await eventually(() => {
            assert.equal(fixture.getBackupCalls(), testCase.wantBackupCalls);
            assert.equal(fixture.getPruneCalls(), 1);
          });
        }
        const failure = logs.find((event) => event.message === 'scheduled backup failed');
        assert.ok(failure);
        for (const [field, want] of Object.entries(testCase.wantFields)) {
          assert.equal(failure.fields?.[field], want, field);
        }
      } finally {
        fixture.scheduler.stop();
      }
    });
  }

  function sqliteBackupError(): Error {
    const error = new Error('not an error') as Error & {
      backupDir: string;
      backupTargetPath: string;
      code: string;
      partialTargetRemoved: boolean;
      partialTargetRemovalCode: string;
    };
    error.name = 'SqliteError';
    error.backupDir = SQLITE_DIR;
    error.backupTargetPath = SQLITE_TARGET;
    error.code = 'SQLITE_BUSY';
    error.partialTargetRemoved = false;
    error.partialTargetRemovalCode = 'EACCES';
    return error;
  }
});

// A pending retry timer keeps the event loop alive; a stopped scheduler that still
// fires a backup minutes later would write into a closed database.
describe('Scheduler pending backup retries', () => {
  const cases: Array<{
    name: string;
    recoverOnRetry: boolean;
    clear(fixture: ReturnType<typeof createBackupSchedulerFixture>): Promise<void> | void;
  }> = [
    {
      name: 'When a later cycle succeeds then should clear the pending retry',
      recoverOnRetry: true,
      clear: (fixture) => fixture.scheduler.runBackupCycle('interval'),
    },
    {
      name: 'When the scheduler stops then should clear the pending retry timer',
      recoverOnRetry: false,
      clear: (fixture) => fixture.scheduler.stop(),
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const fixture = createBackupSchedulerFixture({
        backupRetryDelayMs: 60_000,
        backupNow: failingBackup(
          () => new Error('backup failed'),
          testCase.recoverOnRetry ? '/tmp/state-ok.db' : undefined,
        ),
      });
      try {
        await fixture.scheduler.runBackupCycle('interval');
        assert.notEqual(pendingRetry(fixture.scheduler), undefined);

        await testCase.clear(fixture);

        assert.equal(pendingRetry(fixture.scheduler), undefined);
      } finally {
        fixture.scheduler.stop();
      }
    });
  }
});

function createBackupSchedulerFixture(options?: {
  backupNow?: () => Promise<string>;
  backupRetryDelayMs?: number;
}) {
  const config = loadConfig();
  config.workflows.logReviewer.enabled = false;
  config.workflows.prMaintainer.enabled = false;
  config.store.backupIntervalMin = 60;
  config.store.backupRetentionCount = 2;
  let pruneCalls = 0;
  let backupCalls = 0;
  const backupDir = path.join(tmpdir(), 'jardinero-backup-scheduler-fake');
  const backupNow = options?.backupNow ?? (async () => path.join(backupDir, 'state-ok.db'));
  const store = {
    backupsDir: backupDir,
    backupNow: async () => {
      backupCalls += 1;
      return backupNow();
    },
    pruneBackups: (retainCount: number) => {
      pruneCalls += 1;
      assert.equal(retainCount, config.store.backupRetentionCount);
      return [];
    },
  };
  const scheduler = new Scheduler(config, {
    store: store as unknown as ConstructorParameters<typeof Scheduler>[1]['store'],
    orchestrator: idleMachines(),
    commands: {
      announceLogReview: () => Promise.resolve({ announced: [], unknownRepositories: [] }),
    },
    backupRetryDelayMs: options?.backupRetryDelayMs ?? 0,
  });
  return {
    scheduler,
    config,
    getPruneCalls: () => pruneCalls,
    getBackupCalls: () => backupCalls,
  };
}

function pendingRetry(scheduler: Scheduler): NodeJS.Timeout | undefined {
  return (scheduler as unknown as { backupRetryTimeout?: NodeJS.Timeout }).backupRetryTimeout;
}

// A backup that fails its first attempt and then either recovers or keeps failing,
// which is what both the retry logging and the pending-retry lifecycle are about.
function failingBackup(error: () => unknown, recoveredPath?: string): () => Promise<string> {
  let attempts = 0;
  return async () => {
    attempts += 1;
    if (attempts === 1 || recoveredPath === undefined) throw error();
    return recoveredPath;
  };
}

// idleMachines answer nothing: this suite asserts what the clock does, not what a
// machine does with a time event.
function idleMachines(): ConstructorParameters<typeof Scheduler>[1]['orchestrator'] {
  return {
    prMaintainer: { onPrDiscovered: () => Promise.resolve(undefined) },
  } as unknown as ConstructorParameters<typeof Scheduler>[1]['orchestrator'];
}
