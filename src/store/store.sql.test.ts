import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { Store } from './store.js';
import { type StoreFixture, createTestStore } from '../testing/store.js';

const SCHEMA_PATH = path.join(process.cwd(), 'db', 'schema.sql');

let fixture: StoreFixture;
let store: Store;

beforeEach(() => {
  fixture = createTestStore();
  store = fixture.store;
});

afterEach(() => {
  fixture.cleanup();
});

describe('Store.queryReadOnly', () => {
  // The capsule exposes this behind the admin token, so anything that could write
  // has to be refused rather than sanitized.
  const cases: Array<{ name: string; sql: string; wantError?: RegExp }> = [
    { name: 'When the query is a `SELECT` then should return its rows', sql: 'SELECT 1 AS one' },
    {
      name: 'When the query is a `WITH` then should return its rows',
      sql: 'WITH numbers AS (SELECT 1 AS one) SELECT * FROM numbers',
    },
    {
      name: 'When the query is a `PRAGMA` then should return its rows',
      sql: 'PRAGMA user_version',
    },
    {
      name: 'When the query ends in a semicolon then should still run it',
      sql: 'SELECT 1 AS one;  ',
    },
    {
      name: 'When the statement writes then should return error',
      sql: 'DELETE FROM sandbox_run',
      wantError: /read-only/,
    },
    {
      name: 'When a write is chained after a read then should return error',
      sql: 'SELECT 1; DROP TABLE sandbox_run',
      wantError: /single SQL statement/,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      if (testCase.wantError) {
        assert.throws(() => store.queryReadOnly(testCase.sql), testCase.wantError);
        return;
      }

      assert.equal(store.queryReadOnly(testCase.sql).length, 1);
    });
  }

  test('When the query is parameterized then should bind the parameters', () => {
    const [row] = store.queryReadOnly('SELECT ?1 AS echoed', ['hello']) as Array<{
      echoed: string;
    }>;

    assert.equal(row.echoed, 'hello');
  });
});

describe('Store.transaction', () => {
  test('When the body returns then should commit its writes', () => {
    const written = store.transaction(() => store.upsertRepository('acme/orchestrator').id);

    assert.equal(store.getRepositoryById(written)?.fullName, 'acme/orchestrator');
  });

  // Callers wrap several writes that only make sense together, so a failure must
  // leave none of them behind.
  test('When the body throws then should roll back and rethrow', () => {
    assert.throws(
      () =>
        store.transaction(() => {
          store.upsertRepository('acme/orchestrator');
          throw new Error('half way');
        }),
      /half way/,
    );
    assert.equal(store.findRepositoryByFullName('acme/orchestrator'), undefined);
  });
});

describe('Store schema migration', () => {
  test('When a database has the old dismissed-state schema then should accept dismissed endings', () => {
    const dataPath = mkdtempSync(path.join(tmpdir(), 'jardinero-dismissed-schema-'));
    seedPreDismissedStateSchema(dataPath);

    let migrated: Store | undefined;
    try {
      migrated = new Store({ dataPath, schemaPath: SCHEMA_PATH });
      const active = migrated;
      const repository = active.findRepositoryByFullName('acme/orchestrator');
      assert.ok(repository);

      active.setLinearImplementerState('li-1', 'li_dismissed');
      active.setFixImplementerState('fi-1', 'fi_dismissed');
      active.setPrMaintainerState('prm-1', 'prm_dismissed');

      assert.doesNotThrow(() =>
        active.openLinearImplementer({
          repositoryId: repository.id,
          linearIssueId: 'iss-1',
          linearIssueIdentifier: 'JAR-61',
        }),
      );
      assert.doesNotThrow(() =>
        active.openFixImplementer({
          repositoryId: repository.id,
          findingFingerprint: 'fp-1',
        }),
      );
      assert.doesNotThrow(() =>
        active.openPrMaintainer({ repositoryId: repository.id, pullRequestNumber: 7 }),
      );
    } finally {
      migrated?.close();
      rmSync(dataPath, { recursive: true, force: true });
    }
  });
});

function seedPreDismissedStateSchema(dataPath: string): void {
  const db = new DatabaseSync(path.join(dataPath, 'state.db'));
  db.exec(`
    CREATE TABLE repository (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL UNIQUE,
      discord_webhook_url TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE linear_implementer (
      id TEXT PRIMARY KEY,
      request_router_id TEXT,
      workflow_state TEXT NOT NULL CHECK (
        workflow_state IN (
          'li_pending', 'li_implementing', 'li_verifying', 'li_needs_human',
          'li_waiting_pr', 'li_done', 'li_abandoned'
        )
      ),
      repository_id TEXT NOT NULL,
      linear_issue_id TEXT NOT NULL,
      linear_issue_identifier TEXT NOT NULL,
      linear_session_id TEXT,
      prompt_context TEXT,
      branch_name TEXT,
      pull_request_number INTEGER,
      iteration_number INTEGER NOT NULL DEFAULT 0,
      transient_retry_count INTEGER NOT NULL DEFAULT 0,
      verified_commit_sha TEXT,
      verifier_verdict TEXT,
      verifier_issues TEXT,
      sandbox_run_id TEXT,
      needs_human_reason TEXT,
      last_state_checked_at INTEGER,
      state_changed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX uq_linear_implementer_open
      ON linear_implementer (linear_issue_id)
      WHERE workflow_state NOT IN ('li_done', 'li_abandoned');
    CREATE INDEX idx_linear_implementer_due
      ON linear_implementer (workflow_state, last_state_checked_at)
      WHERE workflow_state NOT IN ('li_done', 'li_abandoned');
    CREATE TABLE log_reviewer (
      id TEXT PRIMARY KEY,
      request_router_id TEXT,
      workflow_state TEXT NOT NULL CHECK (
        workflow_state IN ('lr_pending', 'lr_working', 'lr_done', 'lr_failed')
      ),
      repository_id TEXT NOT NULL,
      service_name TEXT,
      environment_name TEXT,
      finding_count INTEGER NOT NULL DEFAULT 0,
      sandbox_run_id TEXT,
      last_state_checked_at INTEGER,
      state_changed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE fix_implementer (
      id TEXT PRIMARY KEY,
      log_reviewer_id TEXT,
      workflow_state TEXT NOT NULL CHECK (
        workflow_state IN (
          'fi_pending', 'fi_implementing', 'fi_verifying', 'fi_needs_human',
          'fi_discarded', 'fi_waiting_pr', 'fi_done', 'fi_abandoned'
        )
      ),
      repository_id TEXT NOT NULL,
      finding_fingerprint TEXT NOT NULL,
      service_name TEXT,
      environment_name TEXT,
      finding_evidence TEXT,
      branch_name TEXT,
      pull_request_number INTEGER,
      verified_commit_sha TEXT,
      verifier_verdict TEXT,
      verifier_issues TEXT,
      sandbox_run_id TEXT,
      needs_human_reason TEXT,
      discard_reason TEXT,
      last_state_checked_at INTEGER,
      state_changed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX uq_fix_implementer_open
      ON fix_implementer (finding_fingerprint)
      WHERE workflow_state NOT IN ('fi_discarded', 'fi_done', 'fi_abandoned');
    CREATE INDEX idx_fix_implementer_due
      ON fix_implementer (workflow_state, last_state_checked_at)
      WHERE workflow_state NOT IN ('fi_discarded', 'fi_done', 'fi_abandoned');
    CREATE TABLE pr_maintainer (
      id TEXT PRIMARY KEY,
      request_router_id TEXT,
      workflow_state TEXT NOT NULL CHECK (
        workflow_state IN (
          'prm_pending', 'prm_working', 'prm_waiting',
          'prm_attempts_exhausted', 'prm_merged', 'prm_closed'
        )
      ),
      repository_id TEXT NOT NULL,
      pull_request_number INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_acted_commit_sha TEXT,
      requester_person_id TEXT,
      sandbox_run_id TEXT,
      needs_human_reason TEXT,
      last_state_checked_at INTEGER,
      state_changed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX uq_pr_maintainer_open
      ON pr_maintainer (repository_id, pull_request_number)
      WHERE workflow_state NOT IN ('prm_merged', 'prm_closed');
    CREATE INDEX idx_pr_maintainer_due
      ON pr_maintainer (workflow_state, last_state_checked_at)
      WHERE workflow_state NOT IN ('prm_merged', 'prm_closed');
    INSERT INTO repository VALUES ('repo-1', 'acme/orchestrator', NULL, 1, 1, 1);
    INSERT INTO linear_implementer VALUES (
      'li-1', NULL, 'li_needs_human', 'repo-1', 'iss-1', 'JAR-61',
      NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, 'stuck', NULL, 1, 1, 1
    );
    INSERT INTO fix_implementer VALUES (
      'fi-1', NULL, 'fi_needs_human', 'repo-1', 'fp-1',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'stuck', NULL, NULL, 1, 1, 1
    );
    INSERT INTO pr_maintainer VALUES (
      'prm-1', NULL, 'prm_attempts_exhausted', 'repo-1', 7,
      2, NULL, NULL, NULL, 'stuck', NULL, 1, 1, 1
    );
  `);
  db.close();
}
