import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, test } from 'node:test';
import type { AppConfig } from '../../config.js';
import { eventually } from '../../testing/http.js';
import {
  buildAppJwt,
  fetchInstallationToken,
  GitHubTokenError,
  type GitHubTokenPermissions,
  type InstallationToken,
  isRetriableTokenError,
  mintRestrictedToken,
  refreshGitHubAppToken,
  refreshRepoGitHubAppTokens,
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
  const MINTED = { token: 'ghs_ok', expires_at: '2026-01-01T00:00:00Z' };
  const cases: Array<{
    name: string;
    responses: Array<{ status: number; body: unknown }>;
    permissions?: GitHubTokenPermissions;
    want: { result: InstallationToken | { rejected: string }; calls: number; body: unknown };
  }> = [
    {
      name: 'When the exchange succeeds then should return the token and its expiry',
      responses: [{ status: 201, body: MINTED }],
      want: {
        result: { token: 'ghs_ok', expiresAt: '2026-01-01T00:00:00Z' },
        calls: 1,
        body: undefined,
      },
    },
    {
      name: 'When permissions are given then should send them as the request body',
      responses: [{ status: 201, body: MINTED }],
      permissions: { contents: 'read' },
      want: {
        result: { token: 'ghs_ok', expiresAt: '2026-01-01T00:00:00Z' },
        calls: 1,
        body: { permissions: { contents: 'read' } },
      },
    },
    {
      name: 'When the response is 401 then should return error without retrying',
      responses: [{ status: 401, body: { message: 'Bad credentials' } }],
      want: {
        result: { rejected: 'GitHub App installation token request failed: 401' },
        calls: 1,
        body: undefined,
      },
    },
    {
      name: 'When the body is missing fields then should return error',
      responses: [{ status: 201, body: { token: 'only-token' } }],
      want: {
        result: { rejected: 'GitHub App installation token response missing token/expires_at' },
        calls: 1,
        body: undefined,
      },
    },
    {
      name: 'When the first attempt returns 5xx then should retry and succeed',
      responses: [
        { status: 503, body: {} },
        { status: 201, body: MINTED },
      ],
      want: {
        result: { token: 'ghs_ok', expiresAt: '2026-01-01T00:00:00Z' },
        calls: 2,
        body: undefined,
      },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const seq = sequencedFetch(c.responses);
      const result = await fetchInstallationToken('jwt', '42', seq.fetch, c.permissions).catch(
        (error: Error) => ({ rejected: error.message }),
      );
      assert.deepEqual({ result, calls: seq.calls(), body: seq.requests()[0]?.body }, c.want);
    });
  }
});

describe('refreshGitHubAppToken', () => {
  const cases = [
    {
      name: 'When a token is minted then should write it into the configured env var',
      env: { APP_ID: 'app-1', INSTALL_ID: '7', PRIVATE_KEY: privateKey },
      want: { rejected: undefined, token: 'ghs_minted' },
    },
    {
      name: 'When app id is missing then should return error',
      env: { INSTALL_ID: '7', PRIVATE_KEY: 'k' },
      want: { rejected: 'GitHub App secrets missing from environment: APP_ID', token: undefined },
    },
    {
      name: 'When private key is missing then should return error',
      env: { APP_ID: 'a', INSTALL_ID: '7' },
      want: {
        rejected: 'GitHub App secrets missing from environment: PRIVATE_KEY',
        token: undefined,
      },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const env = { ...c.env } as NodeJS.ProcessEnv;
      const rejected = await refreshGitHubAppToken({
        config: testConfig(),
        env,
        fetchImpl: fakeFetch(201, { token: 'ghs_minted', expires_at: '2026-01-01T00:00:00Z' }),
        nowSeconds: () => 1_700_000_000,
      }).then(
        () => undefined,
        (error: Error) => error.message,
      );
      assert.deepEqual({ rejected, token: env.GITHUB_TOKEN }, c.want);
    });
  }
});

describe('refreshRepoGitHubAppTokens', () => {
  const PUBLIC_APP = {
    appIdEnv: 'PUBLIC_APP_ID',
    installIdEnv: 'PUBLIC_INSTALL_ID',
    privateKeyEnv: 'PUBLIC_PRIVATE_KEY',
    tokenEnv: 'PUBLIC_TOKEN',
  };
  const cases: Array<{
    name: string;
    repos: Record<string, typeof PUBLIC_APP>;
    env: Record<string, string>;
    want: { failures: Array<{ repo: string; reason: string }>; env: Record<string, string> };
  }> = [
    {
      name: 'When no repo names its own App then should mint nothing',
      repos: {},
      env: {},
      want: { failures: [], env: {} },
    },
    {
      name: 'When a repo names its own App then should write that App`s token',
      repos: { 'Acme/widgets': PUBLIC_APP },
      env: { PUBLIC_APP_ID: 'app-public', PUBLIC_INSTALL_ID: '99', PUBLIC_PRIVATE_KEY: privateKey },
      want: {
        failures: [],
        env: {
          PUBLIC_APP_ID: 'app-public',
          PUBLIC_INSTALL_ID: '99',
          PUBLIC_PRIVATE_KEY: privateKey,
          PUBLIC_TOKEN: 'ghs_public',
        },
      },
    },
    {
      name: 'When one App is unreachable then should report it and leave the default token alone',
      repos: { 'Acme/widgets': PUBLIC_APP },
      env: { GITHUB_TOKEN: 'ghs_default' },
      want: {
        failures: [
          {
            repo: 'Acme/widgets',
            reason:
              'GitHub App secrets missing from environment: PUBLIC_APP_ID, PUBLIC_INSTALL_ID, PUBLIC_PRIVATE_KEY',
          },
        ],
        env: { GITHUB_TOKEN: 'ghs_default' },
      },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const config = testConfig();
      config.githubApp.repos = c.repos;
      const env = { ...c.env } as NodeJS.ProcessEnv;

      const failures = await refreshRepoGitHubAppTokens({
        config,
        env,
        fetchImpl: fakeFetch(201, { token: 'ghs_public', expires_at: '2026-01-01T00:00:00Z' }),
        nowSeconds: () => 1_700_000_000,
      });

      assert.deepEqual(
        {
          failures: failures.map(({ repo, error }) => ({ repo, reason: error.message })),
          env: { ...env },
        },
        c.want,
      );
    });
  }
});

describe('mintRestrictedToken', () => {
  const PERMISSIONS: GitHubTokenPermissions = { contents: 'write', pull_requests: 'write' };
  const cases: Array<{
    name: string;
    repo: string;
    want: {
      result: InstallationToken;
      requests: Array<{ url: string; body: unknown }>;
    };
  }> = [
    {
      name: 'When the repo names its own App then should mint under that App',
      repo: 'acme/widgets',
      want: {
        result: { token: 'ghs_scoped', expiresAt: '2026-01-01T00:00:00Z' },
        requests: [
          {
            url: 'https://api.github.com/app/installations/99/access_tokens',
            body: { permissions: PERMISSIONS },
          },
        ],
      },
    },
    {
      name: 'When the repo has no App of its own then should mint under the default App',
      repo: 'Acme/gadgets',
      want: {
        result: { token: 'ghs_scoped', expiresAt: '2026-01-01T00:00:00Z' },
        requests: [
          {
            url: 'https://api.github.com/app/installations/7/access_tokens',
            body: { permissions: PERMISSIONS },
          },
        ],
      },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const config = testConfig();
      config.githubApp.repos = {
        'Acme/widgets': {
          appIdEnv: 'PUBLIC_APP_ID',
          installIdEnv: 'PUBLIC_INSTALL_ID',
          privateKeyEnv: 'PUBLIC_PRIVATE_KEY',
          tokenEnv: 'PUBLIC_TOKEN',
        },
      };
      const env = {
        ...refresherEnv(),
        PUBLIC_APP_ID: 'app-public',
        PUBLIC_INSTALL_ID: '99',
        PUBLIC_PRIVATE_KEY: privateKey,
      } as NodeJS.ProcessEnv;
      const before = { ...env };
      const seq = sequencedFetch([
        { status: 201, body: { token: 'ghs_scoped', expires_at: '2026-01-01T00:00:00Z' } },
      ]);

      const result = await mintRestrictedToken({
        config,
        env,
        repo: c.repo,
        permissions: PERMISSIONS,
        fetchImpl: seq.fetch,
        nowSeconds: () => 1_700_000_000,
      });

      assert.deepEqual({ result, requests: seq.requests() }, c.want);
      assert.deepEqual(env, before);
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

  test('When a repo App cannot be read then should log it and still boot', async () => {
    const logs = recordingLogger();
    const config = testConfig();
    config.githubApp.repos = {
      'Acme/widgets': {
        appIdEnv: 'PUBLIC_APP_ID',
        installIdEnv: 'PUBLIC_INSTALL_ID',
        privateKeyEnv: 'PUBLIC_PRIVATE_KEY',
        tokenEnv: 'PUBLIC_TOKEN',
      },
    };
    const env = refresherEnv();

    const refresher = await startGitHubAppTokenRefresher({
      config,
      env,
      fetchImpl: fakeFetch(201, { token: 'ghs_1', expires_at: '2026-01-01T00:00:00Z' }),
      nowSeconds: () => 1_700_000_000,
      logger: logs.logger,
    });
    refresher.stop();

    assert.deepEqual(logs.info, ['github app installation token minted']);
    assert.deepEqual(logs.error, ['repo github app installation token refresh failed']);
    assert.equal(env.GITHUB_TOKEN, 'ghs_1');
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
  requests: () => Array<{ url: string; body: unknown }>;
} {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const r = responses[Math.min(requests.length, responses.length - 1)];
    requests.push({
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetch: fn, calls: () => requests.length, requests: () => requests };
}

function testConfig(): AppConfig {
  return {
    worker: { githubTokenEnv: 'GITHUB_TOKEN' },
    githubApp: {
      appIdEnv: 'APP_ID',
      installIdEnv: 'INSTALL_ID',
      privateKeyEnv: 'PRIVATE_KEY',
      tokenRefreshMin: 10,
      repos: {},
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
