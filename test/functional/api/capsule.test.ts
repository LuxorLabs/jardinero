import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Store } from '../../../src/store/store.js';
import { createHttpFixture } from '../../../src/testing/http.js';

const ADMIN = { authorization: 'Bearer admin-token' };

describe('GET /capsule/runs', () => {
  test('When runs exist then should list them newest first and filter by state', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      const seeded = seedRun(fixture);

      const all = await fetch(`${fixture.baseUrl}/capsule/runs`, { headers: ADMIN });
      const body = (await all.json()) as { runs: Array<{ id: string; runState: string }> };
      assert.equal(all.status, 200);
      assert.deepEqual(
        body.runs.map((run) => run.id),
        [seeded],
      );

      const failed = await fetch(`${fixture.baseUrl}/capsule/runs?state=failed`, {
        headers: ADMIN,
      });
      const filtered = (await failed.json()) as { runs: unknown[] };
      assert.deepEqual(filtered.runs, []);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('GET /capsule/runs/{id}/events', () => {
  test('When the run reported events then should stream them as one json per line', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      const seeded = seedRun(fixture);
      fixture.store.appendEvent({
        eventType: 'sandbox.ready',
        sandboxRunId: seeded,
        metadata: { message: 'the sandbox is up' },
      });

      const response = await fetch(`${fixture.baseUrl}/capsule/runs/${seeded}/events`, {
        headers: ADMIN,
      });
      const lines = (await response.text()).trim().split('\n');

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
      assert.deepEqual(
        lines.map((line) => (JSON.parse(line) as { eventType: string }).eventType),
        ['sandbox.ready'],
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the run id is not a uuid then should return error', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      const response = await fetch(`${fixture.baseUrl}/capsule/runs/not-a-uuid/events`, {
        headers: ADMIN,
      });

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'invalid_run_id' });
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('POST /capsule/sql', () => {
  // The capsule is how an agent inspects a live instance, so a read-only statement
  // has to come back as rows while anything that could write is refused. All four
  // share one server boot.
  test('When statements are posted then should answer reads and refuse writes', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      const select = await sql(fixture, 'select 1 as one');
      assert.equal(select.status, 200);
      assert.deepEqual(await select.json(), { rows: [{ one: 1 }] });

      const parameterized = await sql(fixture, 'select ?1 as echoed', ['hello']);
      assert.equal(parameterized.status, 200);
      assert.deepEqual(await parameterized.json(), { rows: [{ echoed: 'hello' }] });

      const write = await sql(fixture, "delete from sandbox_run where id = 'x'");
      assert.equal(write.status, 500);

      const chained = await sql(fixture, 'select 1; drop table sandbox_run');
      assert.equal(chained.status, 500);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the admin token is missing then should return error', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      const response = await fetch(`${fixture.baseUrl}/capsule/sql`, {
        method: 'POST',
        body: JSON.stringify({ sql: 'select 1' }),
      });

      assert.equal(response.status, 401);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the route is unknown then should return error', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      const response = await fetch(`${fixture.baseUrl}/capsule/nope`, { headers: ADMIN });

      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'capsule_route_not_found' });
    } finally {
      await fixture.cleanup();
    }
  });
});

function seedRun(fixture: { store: Store }): string {
  const repositoryId = fixture.store.upsertRepository('acme/orchestrator').id;
  const instance = fixture.store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 });
  return fixture.store.startSandboxRun({
    agentName: 'PrMaintainer',
    workflowType: 'pr_maintainer',
    workflowInstanceId: instance.id,
  }).id;
}

function sql(
  fixture: { baseUrl: string },
  statement: string,
  params?: unknown[],
): Promise<Response> {
  return fetch(`${fixture.baseUrl}/capsule/sql`, {
    method: 'POST',
    headers: { ...ADMIN, 'content-type': 'application/json' },
    body: JSON.stringify({ sql: statement, ...(params ? { params } : {}) }),
  });
}
