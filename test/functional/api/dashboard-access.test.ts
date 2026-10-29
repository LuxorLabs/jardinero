import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createHttpFixture } from '../../../src/testing/http.js';
import {
  PROXY_JWT,
  createJwtSigner,
  jwksFetch,
  proxyJwtClaims,
} from '../../../src/testing/proxy-jwt.js';

describe('Requests with `auth.proxy_jwt` set', () => {
  const signer = createJwtSigner();

  const cases: Array<{
    name: string;
    path: string;
    jwksAnswer: 'served' | 502;
    headers: () => Record<string, string>;
    want: number;
  }> = [
    {
      name: 'When `/dashboard` carries no JWT then should answer 401',
      path: '/dashboard',
      jwksAnswer: 'served',
      headers: () => ({}),
      want: 401,
    },
    {
      name: 'When `/dashboard/api/session` carries a valid JWT then should answer 200',
      path: '/dashboard/api/session',
      jwksAnswer: 'served',
      headers: () => ({ 'x-pomerium-jwt-assertion': signer.sign(proxyJwtClaims()) }),
      want: 200,
    },
    {
      name: 'When the JWKS was never fetched and cannot be then should answer 503',
      path: '/dashboard/api/session',
      jwksAnswer: 502,
      headers: () => ({ 'x-pomerium-jwt-assertion': signer.sign(proxyJwtClaims()) }),
      want: 503,
    },
    {
      name: 'When `/setup` carries no JWT then should answer the report',
      path: '/setup',
      jwksAnswer: 'served',
      headers: () => ({}),
      want: 200,
    },
    {
      name: 'When `/health` carries no JWT then should answer 200',
      path: '/health',
      jwksAnswer: 'served',
      headers: () => ({}),
      want: 200,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const fixture = await createHttpFixture(
        { ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' },
        {
          proxyJwt: PROXY_JWT,
          fetchImpl:
            testCase.jwksAnswer === 502
              ? async () => new Response('down', { status: 502 })
              : jwksFetch(signer),
        },
      );
      try {
        const response = await fetch(`${fixture.baseUrl}${testCase.path}`, {
          headers: testCase.headers(),
        });
        await response.body?.cancel();

        assert.equal(response.status, testCase.want);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});
