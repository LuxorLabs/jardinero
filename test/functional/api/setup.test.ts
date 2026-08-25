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
});
