import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { DashboardSnapshot } from '../../../src/transport/dashboard/dashboard-api-types.js';
import type { Store } from '../../../src/store/store.js';
import {
  createAgentsHttpFixture,
  createHttpFixture,
  postJson,
  readStreamUntil,
  snapshotVersion,
} from '../../../src/testing/http.js';

describe('GET /dashboard/api/session', () => {
  test('When the operator opens the dashboard then should answer the header snapshot', async () => {
    const fixture = await createHttpFixture({}, { maxConcurrentSandboxes: 4 });
    try {
      seedFactory(fixture.store);

      const response = await fetch(`${fixture.baseUrl}/dashboard/api/session`);
      const body = (await response.json()) as DashboardSnapshot;

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.sandboxes_cap, 4);
      assert.equal(body.sandboxes_running, 0);
      // A finished ticket or scan is not holding anything, so only the stuck one counts.
      assert.equal(body.open_instances, 1);
      assert.equal(body.requires_attention, 1);
      assert.ok(body.version.length > 0);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('GET /dashboard/api/stream', () => {
  test('When a prompt is upserted then should push a new snapshot', async () => {
    const fixture = await createAgentsHttpFixture();
    try {
      const stream = await fetch(`${fixture.baseUrl}/dashboard/api/stream`);
      assert.equal(stream.status, 200);
      assert(stream.body);
      const reader = stream.body.getReader();
      const first = await readStreamUntil(reader, 'dashboard.snapshot');
      const firstVersion = snapshotVersion(first);

      const upsert = await postJson(`${fixture.baseUrl}/dashboard/api/agents/instructions`, {
        repo: '*',
        agent: 'log_reviewer',
        instructions: 'Snapshot version must change.',
        confirmed: true,
      });
      assert.equal(upsert.status, 200);

      const next = await readStreamUntil(reader, 'dashboard.snapshot', 4_000);
      const nextVersion = snapshotVersion(next);
      assert.notEqual(nextVersion, firstVersion);
      await reader.cancel();
    } finally {
      await fixture.cleanup();
    }
  });
});

// A factory with one of everything the snapshot counts: a maintenance that ran out of
// passes, and a scan that finished.
function seedFactory(store: Store): void {
  const repositoryId = store.upsertRepository('acme/orchestrator').id;
  const stuck = store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 });
  store.setPrMaintainerState(stuck.id, 'prm_attempts_exhausted', {
    needsHumanReason: 'attempts_exhausted',
  });
  const scan = store.openLogReviewer({ repositoryId, serviceName: 'jardinero' });
  store.setLogReviewerState(scan.id, 'lr_done', { findingCount: 1 });
}
