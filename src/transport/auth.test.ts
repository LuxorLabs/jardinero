import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, mock, test } from 'node:test';

import { loadConfig } from '../config.js';
import { PROXY_JWT, createJwtSigner, jwksFetch, proxyJwtClaims } from '../testing/proxy-jwt.js';
import {
  type AuthContext,
  constantTimeEquals,
  operatorIdentity,
  requireAdmin,
  requireOperator,
} from './auth.js';

describe('requireAdmin', () => {
  const cases: Array<{
    name: string;
    token?: string;
    authorization?: string | string[];
    want: boolean;
    wantError?: string;
  }> = [
    {
      name: 'When no admin token is configured then should refuse and say so',
      authorization: 'Bearer whatever',
      want: false,
      wantError: 'admin_token_not_configured',
    },
    {
      name: 'When the bearer token matches then should allow',
      token: 'secret',
      authorization: 'Bearer secret',
      want: true,
    },
    {
      name: 'When the header is absent then should refuse',
      token: 'secret',
      want: false,
      wantError: 'unauthorized',
    },
    {
      name: 'When the token differs then should refuse',
      token: 'secret',
      authorization: 'Bearer other!',
      want: false,
      wantError: 'unauthorized',
    },
    {
      name: 'When the scheme is missing then should refuse',
      token: 'secret',
      authorization: 'secret',
      want: false,
      wantError: 'unauthorized',
    },
    {
      name: 'When the header is repeated then should judge the first value',
      token: 'secret',
      authorization: ['Bearer secret', 'Bearer other'],
      want: true,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const config = loadConfig();
      const context: AuthContext = {
        config,
        env: testCase.token ? { [config.auth.adminTokenEnv]: testCase.token } : {},
      };
      const sent: Array<{ status: number; payload: string }> = [];
      const response = {
        writeHead(status: number) {
          sent.push({ status, payload: '' });
        },
        end(payload: string) {
          if (sent.length > 0) sent[sent.length - 1].payload = payload;
        },
      };

      const allowed = requireAdmin(
        context,
        { headers: { authorization: testCase.authorization } } as IncomingMessage,
        response as never,
      );

      assert.equal(allowed, testCase.want);
      if (testCase.want) {
        assert.deepEqual(sent, [], 'an allowed request must not be answered by the guard');
        return;
      }
      assert.equal(sent[0]?.status, 401);
      assert.deepEqual(JSON.parse(sent[0].payload), { error: testCase.wantError });
    });
  }
});

describe('requireOperator', () => {
  const signer = createJwtSigner();

  const cases: Array<{
    name: string;
    configured: boolean;
    token?: string;
    fetchImpl?: typeof fetch;
    want: {
      allowed: boolean;
      sent: Array<{ status: number; body: unknown }>;
      identity: { email: string | null; subject: string | null } | null;
      fetches: number;
    };
  }> = [
    {
      name: 'When `auth.proxy_jwt` is not configured then should allow without naming anyone',
      configured: false,
      want: { allowed: true, sent: [], identity: null, fetches: 0 },
    },
    {
      name: 'When the JWT header is absent then should refuse',
      configured: true,
      want: {
        allowed: false,
        sent: [{ status: 401, body: { error: 'unauthorized' } }],
        identity: null,
        fetches: 0,
      },
    },
    {
      name: 'When the JWT is not three segments then should refuse without fetching the JWKS',
      configured: true,
      token: 'not-a-jwt',
      want: {
        allowed: false,
        sent: [{ status: 401, body: { error: 'unauthorized' } }],
        identity: null,
        fetches: 0,
      },
    },
    {
      name: 'When the JWT names `HS256` then should refuse without fetching the JWKS',
      configured: true,
      token: signer.sign(proxyJwtClaims(), { alg: 'HS256' }),
      want: {
        allowed: false,
        sent: [{ status: 401, body: { error: 'unauthorized' } }],
        identity: null,
        fetches: 0,
      },
    },
    {
      name: 'When no JWKS was ever fetched and the fetch fails then should refuse as unavailable',
      configured: true,
      token: signer.sign(proxyJwtClaims()),
      fetchImpl: async () => new Response('down', { status: 502 }),
      want: {
        allowed: false,
        sent: [{ status: 503, body: { error: 'proxy_jwks_unavailable' } }],
        identity: null,
        fetches: 1,
      },
    },
    {
      name: 'When the `kid` is unknown to a JWKS fetched just now then should refuse without fetching again',
      configured: true,
      token: signer.sign(proxyJwtClaims(), { kid: 'rotated-away' }),
      want: {
        allowed: false,
        sent: [{ status: 401, body: { error: 'unauthorized' } }],
        identity: null,
        fetches: 1,
      },
    },
    {
      name: 'When the JWT was signed for another audience then should refuse',
      configured: true,
      token: signer.sign(proxyJwtClaims({ aud: 'grafana.example.test' })),
      want: {
        allowed: false,
        sent: [{ status: 401, body: { error: 'unauthorized' } }],
        identity: null,
        fetches: 1,
      },
    },
    {
      name: 'When the JWT is valid then should allow and name the operator it signs',
      configured: true,
      token: signer.sign(proxyJwtClaims()),
      want: {
        allowed: true,
        sent: [],
        identity: { email: 'operator@example.test', subject: 'operator-subject' },
        fetches: 1,
      },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      let fetches = 0;
      const fetchImpl = testCase.fetchImpl ?? jwksFetch(signer);
      const context = operatorContext(testCase.configured, (input, init) => {
        fetches += 1;
        return fetchImpl(input, init);
      });
      const request = operatorRequest(testCase.token);
      const response = recordingResponse();

      const allowed = await requireOperator(context, request, response as never);

      assert.deepEqual(
        { allowed, sent: response.sent, identity: operatorIdentity(request) ?? null, fetches },
        testCase.want,
      );
    });
  }
});

describe('operatorIdentity', () => {
  test('When the request was never verified then should answer undefined', () => {
    assert.equal(operatorIdentity(operatorRequest(undefined)), undefined);
  });
});

describe('Proxy JWKS cache', () => {
  afterEach(() => mock.timers.reset());

  const cases: Array<{
    name: string;
    answers: Array<'current' | 'rotated' | 502>;
    steps: Array<{ advanceMs: number; signer: 'current' | 'rotated' }>;
    want: { fetches: number; statuses: Array<number | undefined> };
  }> = [
    {
      name: 'When two requests arrive within the TTL then should fetch the JWKS once',
      answers: ['current', 'current'],
      steps: [
        { advanceMs: 0, signer: 'current' },
        { advanceMs: 60_000, signer: 'current' },
      ],
      want: { fetches: 1, statuses: [undefined, undefined] },
    },
    {
      name: 'When the TTL has passed then should fetch the JWKS again',
      answers: ['current', 'current'],
      steps: [
        { advanceMs: 0, signer: 'current' },
        { advanceMs: 300_000, signer: 'current' },
      ],
      want: { fetches: 2, statuses: [undefined, undefined] },
    },
    {
      name: 'When the first fetch fails then should answer 503 and fetch again on the next request',
      answers: [502, 'current'],
      steps: [
        { advanceMs: 0, signer: 'current' },
        { advanceMs: 0, signer: 'current' },
      ],
      want: { fetches: 2, statuses: [503, undefined] },
    },
    {
      name: 'When the refresh after the TTL fails then should keep verifying with the last good JWKS until the next TTL',
      answers: ['current', 502, 'current'],
      steps: [
        { advanceMs: 0, signer: 'current' },
        { advanceMs: 300_000, signer: 'current' },
        { advanceMs: 60_000, signer: 'current' },
      ],
      want: { fetches: 2, statuses: [undefined, undefined, undefined] },
    },
    {
      name: 'When a rotated `kid` arrives past the refetch age then should fetch again and allow',
      answers: ['current', 'rotated'],
      steps: [
        { advanceMs: 0, signer: 'current' },
        { advanceMs: 30_000, signer: 'rotated' },
      ],
      want: { fetches: 2, statuses: [undefined, undefined] },
    },
    {
      name: 'When a rotated `kid` arrives within the refetch age then should refuse without fetching',
      answers: ['current', 'rotated'],
      steps: [
        { advanceMs: 0, signer: 'current' },
        { advanceMs: 10_000, signer: 'rotated' },
      ],
      want: { fetches: 1, statuses: [undefined, 401] },
    },
    {
      name: 'When the refetch for a rotated `kid` fails then should refuse it and keep the last good JWKS',
      answers: ['current', 502, 'current'],
      steps: [
        { advanceMs: 0, signer: 'current' },
        { advanceMs: 30_000, signer: 'rotated' },
        { advanceMs: 0, signer: 'current' },
      ],
      want: { fetches: 2, statuses: [undefined, 401, undefined] },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      mock.timers.enable({ apis: ['Date'], now: Date.now() });
      const signers = {
        current: createJwtSigner('current-key'),
        rotated: createJwtSigner('rotated-key'),
      };
      const answers = [...testCase.answers];
      let fetches = 0;
      const context = operatorContext(true, async (input, init) => {
        fetches += 1;
        const answer = answers.shift() ?? 502;
        return answer === 502
          ? new Response('down', { status: 502 })
          : jwksFetch(signers[answer])(input, init);
      });

      const statuses: Array<number | undefined> = [];
      for (const step of testCase.steps) {
        mock.timers.tick(step.advanceMs);
        const response = recordingResponse();
        await requireOperator(
          context,
          operatorRequest(signers[step.signer].sign(proxyJwtClaims())),
          response as never,
        );
        statuses.push(response.sent[0]?.status);
      }

      assert.deepEqual({ fetches, statuses }, testCase.want);
    });
  }
});

describe('Proxy JWKS fetches that overlap', () => {
  afterEach(() => mock.timers.reset());

  test('When a replaced fetch fails after a newer one started then should keep the newer one cached', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const signer = createJwtSigner();
    const pending: Array<(response: Response) => void> = [];
    let fetches = 0;
    const context = operatorContext(true, async () => {
      fetches += 1;
      if (fetches > 2) return new Response('down', { status: 502 });
      return new Promise<Response>((resolve) => pending.push(resolve));
    });
    const responses = [recordingResponse(), recordingResponse(), recordingResponse()];
    const request = () => operatorRequest(signer.sign(proxyJwtClaims()));

    const replaced = requireOperator(context, request(), responses[0] as never);
    mock.timers.tick(300_000);
    const newer = requireOperator(context, request(), responses[1] as never);
    pending[0](new Response('down', { status: 502 }));
    await replaced;
    pending[1](Response.json(signer.jwksBody()));
    await newer;
    await requireOperator(context, request(), responses[2] as never);

    assert.deepEqual(
      { fetches, statuses: responses.map((response) => response.sent[0]?.status) },
      { fetches: 2, statuses: [503, undefined, undefined] },
    );
  });
});

describe('constantTimeEquals', () => {
  const cases: Array<{ name: string; a: string; b: string; want: boolean }> = [
    { name: 'When both values match then should return true', a: 'abc', b: 'abc', want: true },
    { name: 'When the values differ then should return false', a: 'abc', b: 'abd', want: false },
    { name: 'When the lengths differ then should return false', a: 'abc', b: 'abcd', want: false },
    { name: 'When both values are empty then should return true', a: '', b: '', want: true },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(constantTimeEquals(testCase.a, testCase.b), testCase.want);
    });
  }
});

function operatorContext(configured: boolean, fetchImpl: typeof fetch): AuthContext {
  const config = loadConfig();
  config.auth.proxyJwt = configured ? PROXY_JWT : null;
  return { config, env: {}, fetchImpl };
}

function operatorRequest(token: string | undefined): IncomingMessage {
  return { headers: token ? { 'x-pomerium-jwt-assertion': token } : {} } as IncomingMessage;
}

function recordingResponse() {
  const sent: Array<{ status: number; body: unknown }> = [];
  return {
    sent,
    writeHead(status: number) {
      sent.push({ status, body: undefined });
    },
    end(payload: string) {
      if (sent.length > 0) sent[sent.length - 1].body = JSON.parse(payload);
    },
  };
}
