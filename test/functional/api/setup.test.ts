import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createHttpFixture } from '../../../src/testing/http.js';

interface SetupReport {
  status: string;
  checks: Array<{ name: string; status: string; detail: string }>;
}

describe('GET /setup', () => {
  // The report exists to say what a deployment is still missing, and the admin
  // token is usually one of the missing things, so this route carries no auth.
  test('When no credentials are configured then should answer the report without a token', async () => {
    const fixture = await createHttpFixture();
    try {
      const response = await fetch(`${fixture.baseUrl}/setup`);

      assert.equal(response.status, 200);
      const body = (await response.json()) as SetupReport;
      assert.equal(body.status, 'error');
      assert.equal(
        body.checks.find((check) => check.name === 'admin_auth')?.status,
        'error',
        'the token this route deliberately does not require is itself reported',
      );
      assert.equal(body.checks.find((check) => check.name === 'github_app_id')?.status, 'error');
    } finally {
      await fixture.cleanup();
    }
  });

  test('When only optional checks warn then should answer 404', async () => {
    const fixture = await createHttpFixture(
      {
        ORCHESTRATOR_ADMIN_TOKEN: 'admin-token',
        JARDINERO_AGENT_APP_ID: '123',
        JARDINERO_AGENT_INSTALL_ID: '456',
        JARDINERO_AGENT_PRIVATE_KEY:
          '-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----',
        JARDINERO_AGENT_WEBHOOK_SECRET: 'webhook-secret',
        OPENAI_API_KEY: 'sk-test',
      },
      { codexAuthMode: 'api_key', prMaintainerEnabled: false },
    );
    try {
      const response = await fetch(`${fixture.baseUrl}/setup`);
      const preflight = await fetch(`${fixture.baseUrl}/admin/preflight`, {
        headers: { authorization: 'Bearer admin-token' },
      });

      assert.deepEqual(
        {
          status: response.status,
          body: await response.json(),
          preflight: ((await preflight.json()) as SetupReport).status,
        },
        { status: 404, body: { error: 'not_found' }, preflight: 'warning' },
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
