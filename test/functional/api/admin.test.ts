import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createHttpFixture } from '../../../src/testing/http.js';

describe('/admin authentication', () => {
  test('When the admin token is not configured then should return error', async () => {
    const fixture = await createHttpFixture();
    try {
      const response = await fetch(`${fixture.baseUrl}/admin/trigger/log-review`, {
        method: 'POST',
      });
      assert.equal(response.status, 401);
      const body = (await response.json()) as { error: string };
      assert.equal(body.error, 'admin_token_not_configured');
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the bearer token is required then should enforce it', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      const unauthorized = await fetch(`${fixture.baseUrl}/admin/trigger/log-review`, {
        method: 'POST',
      });
      assert.equal(unauthorized.status, 401);

      const authorized = await fetch(`${fixture.baseUrl}/admin/trigger/log-review`, {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token' },
      });
      assert.notEqual(authorized.status, 401);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('GET /admin/preflight', () => {
  test('When requested then should expose the preflight report', async () => {
    const fixture = await createHttpFixture({
      ORCHESTRATOR_ADMIN_TOKEN: 'admin-token',
    });
    try {
      const response = await fetch(`${fixture.baseUrl}/admin/preflight`, {
        headers: { authorization: 'Bearer admin-token' },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { checks: Array<{ name: string }> };
      assert(body.checks.some((check) => check.name === 'worker_runner'));
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('POST /admin/trigger/log-review', () => {
  test('When a configured repo is triggered then should open a scan of it', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      fixture.store.upsertRepository('acme/widgets');

      const response = await fetch(
        `${fixture.baseUrl}/admin/trigger/log-review?repo=${encodeURIComponent('acme/widgets')}`,
        { method: 'POST', headers: { authorization: 'Bearer admin-token' } },
      );

      assert.equal(response.status, 202);
      const instance = fixture.store.listOpenLogReviewers().at(0);
      assert.equal(instance?.serviceName, 'widgets');
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the repository was never seen then should answer 200 naming it', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      const response = await fetch(
        `${fixture.baseUrl}/admin/trigger/log-review?repo=${encodeURIComponent('acme/widgets')}`,
        { method: 'POST', headers: { authorization: 'Bearer admin-token' } },
      );

      assert.equal(response.status, 200);
      const body = (await response.json()) as { unknown_repositories: string[] };
      assert.deepEqual(body.unknown_repositories, ['acme/widgets']);
      assert.deepEqual(fixture.store.listOpenLogReviewers(), []);
    } finally {
      await fixture.cleanup();
    }
  });
});
