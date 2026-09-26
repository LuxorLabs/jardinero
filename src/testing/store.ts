import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Store } from '../store/store.js';

export interface StoreFixture {
  store: Store;
  // Where the store was put, for a caller that has to point its config at the
  // same place.
  dataPath: string;
  cleanup(): void;
}

// A store on a throwaway directory. fsync-per-commit durability is pointless
// there and only makes the suite disk-I/O-bound, so it is off: that keeps
// timing-sensitive tests fast and immune to parallel disk contention.
export function createTestStore(): StoreFixture {
  const dataPath = mkdtempSync(path.join(tmpdir(), 'jardinero-store-test-'));
  const store = new Store({
    dataPath,
    schemaPath: path.join(process.cwd(), 'db', 'schema.sql'),
  });
  store.db.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;');
  return {
    store,
    dataPath,
    cleanup() {
      store.close();
      rmSync(dataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}

// refuseSandboxRunInserts fails every sandbox run insert and keeps the table readable,
// so a case can still assert which runs are left.
export function refuseSandboxRunInserts(store: Store): void {
  store.db.exec(`CREATE TRIGGER refuse_sandbox_run BEFORE INSERT ON sandbox_run
    BEGIN SELECT RAISE(ABORT, 'sandbox run refused'); END`);
}
