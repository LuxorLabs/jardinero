import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createHttpFixture, readEvents } from '../../../src/testing/http.js';

describe('operator writes on the dashboard', () => {
  test('When browsing read only pages then should record no operator write', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      for (const path of [
        '/dashboard',
        '/dashboard/operation',
        '/dashboard/api/overview',
        '/dashboard/api/workflow-instances',
      ]) {
        const response = await fetch(`${fixture.baseUrl}${path}`);
        assert.equal(response.status, 200);
      }

      assert.equal(readEvents(fixture.store, 'operator.dashboard_write_requested').length, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When a mutation carries pomerium identity then should record who asked for it', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      const response = await fetch(`${fixture.baseUrl}/dashboard/api/agents/instructions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pomerium-claim-email': 'operator@example.test',
          'x-pomerium-claim-sub': 'pomerium-subject',
          'x-request-id': 'dashboard-audit-test',
          'user-agent': 'jardinero-test',
        },
        body: JSON.stringify({
          repo: '*',
          agent: 'log_reviewer',
          instructions: 'audited',
          confirmed: true,
        }),
      });
      assert.equal(response.status, 200);

      const entries = readEvents(fixture.store, 'operator.dashboard_write_requested');
      assert.equal(entries.length, 1);
      assert.equal(entries[0].action, 'upsert_prompt');
      assert.equal(entries[0].path, '/dashboard/api/agents/instructions');
      assert.deepEqual(entries[0].session, {
        provider: 'pomerium',
        email: 'operator@example.test',
        subject: 'beedd908963e9467',
      });
      assert.equal(
        (entries[0].request as { request_id?: string }).request_id,
        'dashboard-audit-test',
      );
      assert.doesNotMatch(JSON.stringify(entries[0]), /admin-token/);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When a mutation carries oauth2-proxy identity then should record who asked for it', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      const response = await fetch(`${fixture.baseUrl}/dashboard/api/agents/instructions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-auth-request-email': 'operator@example.test',
          'x-auth-request-user': 'oauth2-subject',
        },
        body: JSON.stringify({
          repo: '*',
          agent: 'log_reviewer',
          instructions: 'audited',
          confirmed: true,
        }),
      });
      assert.equal(response.status, 200);

      const entries = readEvents(fixture.store, 'operator.dashboard_write_requested');
      assert.equal(entries.length, 1);
      assert.equal((entries[0].session as { provider?: string }).provider, 'oauth2-proxy');
      assert.equal((entries[0].session as { email?: string }).email, 'operator@example.test');
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the forwarded email is generic then should record the write without an identity', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      const response = await fetch(`${fixture.baseUrl}/dashboard/api/agents/instructions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-email': 'spoofed@example.test',
          'x-request-id': 'dashboard-audit-forwarded-email-test',
        },
        body: JSON.stringify({
          repo: '*',
          agent: 'log_reviewer',
          instructions: 'audited',
          confirmed: true,
        }),
      });
      assert.equal(response.status, 200);

      const entries = readEvents(fixture.store, 'operator.dashboard_write_requested');
      assert.equal(entries.length, 1);
      assert.equal(entries[0].action, 'upsert_prompt');
      assert.equal(entries[0].session, null);
      assert.equal(
        (entries[0].request as { request_id?: string }).request_id,
        'dashboard-audit-forwarded-email-test',
      );
      assert.doesNotMatch(JSON.stringify(entries[0]), /spoofed@example\.test/);
    } finally {
      await fixture.cleanup();
    }
  });
});
