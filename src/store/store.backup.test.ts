import assert from 'node:assert/strict';
import { existsSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from './store.js';
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

describe('Store.backupNow', () => {
  test('When the backup is written then should audit where it went', async () => {
    const backupPath = await store.backupNow();

    assert.ok(existsSync(backupPath));
    assert.match(path.basename(backupPath), /^state-.+\.db$/);
    assert.equal(recordedBackupPath(store), backupPath);
  });

  // A half-written backup is worse than none: a restore would read it as complete.
  test('When the backup fails then should remove the partial target', async () => {
    const fixedNow = Date.UTC(2026, 0, 2, 3, 4, 5, 6);
    const originalNow = Date.now;
    Date.now = () => fixedNow;
    const target = path.join(store.backupsDir, 'state-2026-01-02T03-04-05-006Z.db');
    try {
      symlinkSync(fixture.dataPath, target);

      await assert.rejects(store.backupNow(), (error) => {
        const failure = error as { backupTargetPath?: string; partialTargetRemoved?: boolean };
        assert.equal(failure.backupTargetPath, target);
        assert.equal(failure.partialTargetRemoved, true);
        return true;
      });
      assert.equal(existsSync(target), false);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe('Store.pruneBackups', () => {
  // Retention is by age, so the newest backups are the ones that survive.
  const cases: Array<{ name: string; retainCount: number; wantKept: string[] }> = [
    {
      name: 'When more backups exist than the retention then should remove the oldest',
      retainCount: 2,
      wantKept: ['state-3.db', 'state-2.db'],
    },
    {
      name: 'When the retention covers every backup then should remove none',
      retainCount: 5,
      wantKept: ['state-3.db', 'state-2.db', 'state-1.db'],
    },
    {
      // A retention below one would delete every backup, so it is refused instead.
      name: 'When the retention is zero then should remove none',
      retainCount: 0,
      wantKept: ['state-3.db', 'state-2.db', 'state-1.db'],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      writeBackup(store, 'state-1.db', 1_000);
      writeBackup(store, 'state-2.db', 2_000);
      writeBackup(store, 'state-3.db', 3_000);

      store.pruneBackups(testCase.retainCount);

      assert.deepEqual(readdirSync(store.backupsDir).sort(), [...testCase.wantKept].sort());
    });
  }

  test('When a file is not a backup then should leave it alone', () => {
    writeBackup(store, 'state-1.db', 1_000);
    writeFileSync(path.join(store.backupsDir, 'notes.txt'), 'keep me');

    const removed = store.pruneBackups(1);

    assert.deepEqual(removed, []);
    assert.ok(existsSync(path.join(store.backupsDir, 'notes.txt')));
  });

  test('When backups are removed then should audit how many', () => {
    writeBackup(store, 'state-1.db', 1_000);
    writeBackup(store, 'state-2.db', 2_000);

    const removed = store.pruneBackups(1);

    assert.deepEqual(removed, [path.join(store.backupsDir, 'state-1.db')]);
    assert.equal(recordedEvents(store, 'orchestrator.backups_deleted'), 1);
  });

  test('When nothing is removed then should not audit a prune', () => {
    writeBackup(store, 'state-1.db', 1_000);

    store.pruneBackups(1);

    assert.equal(recordedEvents(store, 'orchestrator.backups_deleted'), 0);
  });
});

function writeBackup(target: Store, name: string, mtimeSeconds: number): void {
  const absolutePath = path.join(target.backupsDir, name);
  writeFileSync(absolutePath, 'backup');
  utimesSync(absolutePath, mtimeSeconds, mtimeSeconds);
}

function recordedBackupPath(target: Store): string | undefined {
  const [row] = target.queryReadOnly(
    "SELECT json_extract(metadata, '$.path') AS path FROM event_log WHERE event_type = ?",
    ['orchestrator.backup_written'],
  ) as Array<{ path: string }>;
  return row?.path;
}

function recordedEvents(target: Store, eventType: string): number {
  return target.queryReadOnly('SELECT id FROM event_log WHERE event_type = ?', [eventType]).length;
}
