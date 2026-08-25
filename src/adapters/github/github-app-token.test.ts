import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, test } from 'node:test';
import type { AppConfig } from '../../config.js';
import { eventually } from '../../testing/http.js';
import {
  buildAppJwt,
  fetchInstallationToken,
  GitHubTokenError,
  isRetriableTokenError,
  refreshGitHubAppToken,
  startGitHubAppTokenRefresher,
} from './github-app-token.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

describe('buildAppJwt', () => {
  test('When a jwt is built then should sign a verifiable rs256 token with the app claims', () => {
    const now = 1_700_000_000;
    const [header, payload, signature] = buildAppJwt('app-123', privateKey, now).split('.');
    assert.deepEqual(decodeJson(header), { alg: 'RS256', typ: 'JWT' });
    const claims = decodeJson(payload);
    assert.equal(claims.iss, 'app-123');
    assert.equal(claims.iat, now - 60);
    assert.equal(claims.exp, now + 540);
    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, 'base64url'));
    assert.ok(verified);
  });
});

describe('fetchInstallationToken', () => {
  test('When the exchange succeeds then should return the token and its expiry', async () => {
    const result = await fetchInstallationToken(
      'jwt',
      '42',
      fakeFetch(201, { token: 'ghs_abc', expires_at: '2026-01-01T00:00:00Z' }),
    );
    assert.deepEqual(result, { token: 'ghs_abc', expiresAt: '2026-01-01T00:00:00Z' });
  });

  const fetchFailureCases = [
    {
      name: 'When response is not ok then should return error',
      fetchImpl: fakeFetch(401, { message: 'Bad credentials' }),
    },
    {
      name: 'When body is missing fields then should return error',
      fetchImpl: fakeFetch(201, { token: 'only-token' }),
    },
  ];

  for (const c of fetchFailureCases) {
    test(c.name, async () => {
      await assert.rejects(() => fetchInstallationToken('jwt', '42', c.fetchImpl));
    });
  }

  test('When the first attempt returns 5xx then should retry and succeed', async () => {
    const seq = sequencedFetch([
      { status: 503, body: {} },
      { status: 201, body: { token: 'ghs_ok', expires_at: '2026-01-01T00:00:00Z' } },
    ]);
    const result = await fetchInstallationToken('jwt', '42', seq.fetch);
    assert.deepEqual(result, { token: 'ghs_ok', expiresAt: '2026-01-01T00:00:00Z' });
    assert.equal(seq.calls(), 2);
  });

  test('When the response is 401 then should not retry', async () => {
    const seq = sequencedFetch([{ status: 401, body: { message: 'Bad credentials' } }]);
    await assert.rejects(
      () => fetchInstallationToken('jwt', '42', seq.fetch),
      (error: unknown) => error instanceof GitHubTokenError && error.statusCode === 401,
    );
    assert.equal(seq.calls(), 1);
  });
});

describe('refreshGitHubAppToken', () => {
  test('When a token is minted then should write it into the configured env var', async () => {
    const env = { APP_ID: 'app-1', INSTALL_ID: '7', PRIVATE_KEY: privateKey } as NodeJS.ProcessEnv;
    await refreshGitHubAppToken({
      config: testConfig(),
      env,
      fetchImpl: fakeFetch(201, { token: 'ghs_minted', expires_at: '2026-01-01T00:00:00Z' }),
      nowSeconds: () => 1_700_000_000,
    });
    assert.equal(env.GITHUB_TOKEN, 'ghs_minted');
  });

  const missingSecretCases = [
    {
      name: 'When app id is missing then should return error',
      env: { INSTALL_ID: '7', PRIVATE_KEY: 'k' },
      expect: 'APP_ID',
    },
    {
      name: 'When private key is missing then should return error',
      env: { APP_ID: 'a', INSTALL_ID: '7' },
      expect: 'PRIVATE_KEY',
    },
  ];

  for (const c of missingSecretCases) {
    test(c.name, async () => {
      await assert.rejects(
        () =>
          refreshGitHubAppToken({
            config: testConfig(),
            env: c.env as NodeJS.ProcessEnv,
            fetchImpl: fakeFetch(201, {}),
            nowSeconds: () => 0,
          }),
        new RegExp(`secrets missing.*${c.expect}`),
      );
    });
  }
});

describe('startGitHubAppTokenRefresher', () => {
  test('When the first mint succeeds then should log it and expose a stop', async () => {
    const logs = recordingLogger();
    const refresher = await startGitHubAppTokenRefresher({
      config: testConfig(),
      env: refresherEnv(),
      fetchImpl: fakeFetch(201, { token: 'ghs_1', expires_at: '2026-01-01T00:00:00Z' }),
      nowSeconds: () => 1_700_000_000,
      logger: logs.logger,
    });
    refresher.stop();

    assert.deepEqual(logs.info, ['github app installation token minted']);
  });

  // The mint has to fail loudly at boot: a missing GitHub token makes every
  // workflow fail later with an error that no longer names the cause.
  test('When the first mint fails then should return error', async () => {
    await assert.rejects(
      () =>
        startGitHubAppTokenRefresher({
          config: testConfig(),
          env: { INSTALL_ID: '7' } as NodeJS.ProcessEnv,
          fetchImpl: fakeFetch(201, {}),
          nowSeconds: () => 0,
          logger: recordingLogger().logger,
        }),
      /secrets missing/,
    );
  });

  // Whatever the outcome, the next refresh has to be scheduled: two occurrences of
  // the same log line prove the loop kept going rather than settling once.
  const scheduledCases: Array<{
    name: string;
    second: { status: number; body: unknown };
    stream: 'info' | 'error';
    wantMessage: string;
  }> = [
    {
      name: 'When the scheduled refresh succeeds then should log it and schedule the next',
      second: { status: 201, body: { token: 'ghs_2', expires_at: '2026-01-01T00:00:00Z' } },
      stream: 'info',
      wantMessage: 'github app installation token refreshed',
    },
    {
      name: 'When the scheduled refresh fails then should log the error and schedule the next',
      second: { status: 401, body: { message: 'bad credentials' } },
      stream: 'error',
      wantMessage: 'github app installation token refresh failed',
    },
  ];

  for (const testCase of scheduledCases) {
    test(testCase.name, async () => {
      const logs = recordingLogger();
      const config = testConfig();
      config.githubApp.tokenRefreshMin = 1 / 60_000;
      const refresher = await startGitHubAppTokenRefresher({
        config,
        env: refresherEnv(),
        fetchImpl: sequencedFetch([
          { status: 201, body: { token: 'ghs_1', expires_at: '2026-01-01T00:00:00Z' } },
          testCase.second,
        ]).fetch as unknown as typeof fetch,
        nowSeconds: () => 1_700_000_000,
        logger: logs.logger,
      });

      try {
        await eventually(() => {
          const seen = logs[testCase.stream].filter(
            (message) => message === testCase.wantMessage,
          ).length;
          assert.ok(seen >= 2, `expected at least two ${testCase.wantMessage}, saw ${seen}`);
        });
      } finally {
        refresher.stop();
      }
    });
  }
});

describe('isRetriableTokenError', () => {
  const retriableCases = [
    {
      name: 'When status is 429 then should retry',
      error: new GitHubTokenError('x', 429),
      expected: true,
    },
    {
      name: 'When status is 503 then should retry',
      error: new GitHubTokenError('x', 503),
      expected: true,
    },
    {
      name: 'When status is 401 then should not retry',
      error: new GitHubTokenError('x', 401),
      expected: false,
    },
    {
      name: 'When status is 404 then should not retry',
      error: new GitHubTokenError('x', 404),
      expected: false,
    },
    {
      name: 'When error is a network error then should retry',
      error: new Error('socket hang up'),
      expected: true,
    },
  ];

  for (const c of retriableCases) {
    test(c.name, () => {
      assert.equal(isRetriableTokenError(c.error), c.expected);
    });
  }
});

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response) as unknown as typeof fetch;
}

function sequencedFetch(responses: Array<{ status: number; body: unknown }>): {
  fetch: typeof fetch;
  calls: () => number;
} {
  let i = 0;
  const fn = (async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetch: fn, calls: () => i };
}

function testConfig(): AppConfig {
  return {
    worker: { githubTokenEnv: 'GITHUB_TOKEN' },
    githubApp: {
      appIdEnv: 'APP_ID',
      installIdEnv: 'INSTALL_ID',
      privateKeyEnv: 'PRIVATE_KEY',
      tokenRefreshMin: 10,
    },
  } as unknown as AppConfig;
}

function recordingLogger() {
  const info: string[] = [];
  const error: string[] = [];
  return {
    logger: {
      info: (message: string) => info.push(message),
      error: (message: string) => error.push(message),
    } as unknown as Parameters<typeof startGitHubAppTokenRefresher>[0]['logger'],
    info,
    error,
  };
}

function refresherEnv(): NodeJS.ProcessEnv {
  return { APP_ID: 'app-1', INSTALL_ID: '7', PRIVATE_KEY: privateKey } as NodeJS.ProcessEnv;
}
