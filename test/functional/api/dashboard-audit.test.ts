import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createHttpFixture, readEvents } from '../../../src/testing/http.js';
import {
  PROXY_JWT,
  createJwtSigner,
  jwksFetch,
  proxyJwtClaims,
} from '../../../src/testing/proxy-jwt.js';

describe('operator reads on the dashboard', () => {
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
});

describe('operator writes on the dashboard', () => {
  const cases: Array<{
    name: string;
    claims?: Record<string, unknown>;
    headers: Record<string, string>;
    wantSession: unknown;
  }> = [
    {
      name: 'When a mutation carries pomerium identity then should record who asked for it',
      headers: {
        'x-pomerium-claim-email': 'operator@example.test',
        'x-pomerium-claim-sub': 'pomerium-subject',
      },
      wantSession: {
        provider: 'pomerium',
        email: 'operator@example.test',
        subject: 'beedd908963e9467',
      },
    },
    {
      name: 'When a mutation carries oauth2-proxy identity then should record who asked for it',
      headers: {
        'x-auth-request-email': 'operator@example.test',
        'x-auth-request-user': 'oauth2-subject',
      },
      wantSession: {
        provider: 'oauth2-proxy',
        email: 'operator@example.test',
        subject: 'eb092aece5152fc4',
      },
    },
    {
      name: 'When the forwarded email is generic then should record the write without an identity',
      headers: { 'x-forwarded-email': 'spoofed@example.test' },
      wantSession: null,
    },
    {
      name: 'When a forged email header rides beside the proxy JWT then should record the identity the JWT signs',
      claims: { sub: 'pomerium-subject' },
      headers: { 'x-pomerium-claim-email': 'attacker@example.test' },
      wantSession: {
        provider: 'proxy_jwt',
        email: 'operator@example.test',
        subject: 'beedd908963e9467',
      },
    },
    {
      name: 'When the proxy JWT carries no email then should record the identity without one',
      claims: { sub: 'pomerium-subject', email: undefined },
      headers: {},
      wantSession: { provider: 'proxy_jwt', email: null, subject: 'beedd908963e9467' },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const signer = createJwtSigner();
      const fixture = await createHttpFixture(
        { ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' },
        testCase.claims ? { proxyJwt: PROXY_JWT, fetchImpl: jwksFetch(signer) } : {},
      );
      try {
        const response = await fetch(`${fixture.baseUrl}/dashboard/api/agents/instructions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'dashboard-audit-test',
            ...(testCase.claims
              ? { 'x-pomerium-jwt-assertion': signer.sign(proxyJwtClaims(testCase.claims)) }
              : {}),
            ...testCase.headers,
          },
          body: JSON.stringify({
            repo: '*',
            agent: 'log_reviewer',
            instructions: 'audited',
            confirmed: true,
          }),
        });

        const entries = readEvents(fixture.store, 'operator.dashboard_write_requested');
        assert.deepEqual(
          {
            status: response.status,
            writes: entries.map((entry) => ({
              action: entry.action,
              path: entry.path,
              session: entry.session,
              requestId: (entry.request as { request_id?: string }).request_id,
            })),
            leaked: /admin-token|spoofed@example\.test|attacker@example\.test/.test(
              JSON.stringify(entries),
            ),
          },
          {
            status: 200,
            writes: [
              {
                action: 'upsert_prompt',
                path: '/dashboard/api/agents/instructions',
                session: testCase.wantSession,
                requestId: 'dashboard-audit-test',
              },
            ],
            leaked: false,
          },
        );
      } finally {
        await fixture.cleanup();
      }
    });
  }
});
