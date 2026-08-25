import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AppConfig } from '../../config.js';
import { eventually } from '../../testing/http.js';
import {
  fetchClientCredentialsToken,
  isRetriableTokenError,
  LinearTokenError,
  refreshLinearAppToken,
  startLinearAppTokenRefresher,
} from './linear-app-token.js';

describe('refreshLinearAppToken', () => {
  test('When the client credentials are set then should mint a token and write its env var', async () => {
    const env: NodeJS.ProcessEnv = { LINEAR_CLIENT_ID: 'cid', LINEAR_CLIENT_SECRET: 'csec' };
    const result = await refreshLinearAppToken({
      config: testConfig(),
      env,
      fetchImpl: fakeFetch(200, { access_token: 'tok', expires_in: 2591999 }),
    });
    assert.equal(result.token, 'tok');
    assert.equal(result.expiresInSeconds, 2591999);
    assert.equal(env.LINEAR_APP_TOKEN, 'tok');
  });

  test('When the response omits the expiry then should default it to null', async () => {
    const env: NodeJS.ProcessEnv = { LINEAR_CLIENT_ID: 'cid', LINEAR_CLIENT_SECRET: 'csec' };
    const result = await refreshLinearAppToken({
      config: testConfig(),
      env,
      fetchImpl: fakeFetch(200, { access_token: 'tok' }),
    });
    assert.equal(result.expiresInSeconds, null);
  });

  test('When a client credential var is missing then should return error naming it', async () => {
    await assert.rejects(
      refreshLinearAppToken({ config: testConfig(), env: {}, fetchImpl: fakeFetch(200, {}) }),
      /Linear client credentials missing from environment: LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET/,
    );
  });
});

describe('fetchClientCredentialsToken', () => {
  test('When the response is not ok then should return error', async () => {
    await assert.rejects(
      fetchClientCredentialsToken('cid', 'csec', fakeFetch(400, { error: 'invalid_secret' })),
      (error: unknown) => error instanceof LinearTokenError && error.statusCode === 400,
    );
  });

  test('When the response has no `access_token` then should return error', async () => {
    await assert.rejects(
      fetchClientCredentialsToken('cid', 'csec', fakeFetch(200, { expires_in: 5 })),
      /missing access_token/,
    );
  });

  test('When the first attempt fails transiently then should retry and succeed', async () => {
    const seq = sequencedFetch([
      { status: 500, body: {} },
      { status: 200, body: { access_token: 'tok', expires_in: 5 } },
    ]);
    const result = await fetchClientCredentialsToken('cid', 'csec', seq.fetch);
    assert.equal(result.token, 'tok');
    assert.equal(seq.calls(), 2);
  });
});

describe('startLinearAppTokenRefresher', () => {
  test('When the first mint succeeds then should log its expiry and expose a stop', async () => {
    const logs = recordingLogger();
    const refresher = await startLinearAppTokenRefresher({
      config: testConfig(),
      env: refresherEnv(),
      fetchImpl: fakeFetch(200, { access_token: 'tok', expires_in: 2_591_999 }),
      logger: logs.logger,
    });
    refresher.stop();

    assert.deepEqual(logs.info, ['linear app token minted']);
    assert.deepEqual(logs.fields[0], { expires_in_seconds: 2_591_999 });
  });

  // The mint has to fail loudly at boot: without the token every Linear call fails
  // later with an error that no longer names the cause.
  test('When the first mint fails then should return error', async () => {
    await assert.rejects(
      () =>
        startLinearAppTokenRefresher({
          config: testConfig(),
          env: {},
          fetchImpl: fakeFetch(200, {}),
          logger: recordingLogger().logger,
        }),
      /Linear client credentials missing from environment/,
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
      second: { status: 200, body: { access_token: 'tok-2', expires_in: 60 } },
      stream: 'info',
      wantMessage: 'linear app token refreshed',
    },
    {
      name: 'When the scheduled refresh fails then should log the error and schedule the next',
      second: { status: 401, body: { error: 'invalid_client' } },
      stream: 'error',
      wantMessage: 'linear app token refresh failed',
    },
  ];

  for (const testCase of scheduledCases) {
    test(testCase.name, async () => {
      const logs = recordingLogger();
      const config = testConfig();
      config.workflows.linearImplementer.tokenRefreshMin = 1 / 60_000;
      const refresher = await startLinearAppTokenRefresher({
        config,
        env: refresherEnv(),
        fetchImpl: sequencedFetch([
          { status: 200, body: { access_token: 'tok-1', expires_in: 60 } },
          testCase.second,
        ]).fetch as unknown as typeof fetch,
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
      error: new LinearTokenError('x', 429),
      want: true,
    },
    {
      name: 'When status is 500 then should retry',
      error: new LinearTokenError('x', 500),
      want: true,
    },
    {
      name: 'When status is 400 then should not retry',
      error: new LinearTokenError('x', 400),
      want: false,
    },
    {
      name: 'When status is 401 then should not retry',
      error: new LinearTokenError('x', 401),
      want: false,
    },
    {
      name: 'When error is not a token error then should retry',
      error: new Error('network down'),
      want: true,
    },
  ];

  for (const c of retriableCases) {
    test(c.name, () => {
      assert.equal(isRetriableTokenError(c.error), c.want);
    });
  }
});

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
    workflows: {
      linearImplementer: {
        apiTokenEnv: 'LINEAR_APP_TOKEN',
        clientIdEnv: 'LINEAR_CLIENT_ID',
        clientSecretEnv: 'LINEAR_CLIENT_SECRET',
        tokenRefreshMin: 1440,
      },
    },
  } as unknown as AppConfig;
}

function recordingLogger() {
  const info: string[] = [];
  const error: string[] = [];
  const fields: Array<Record<string, unknown> | undefined> = [];
  return {
    logger: {
      info: (message: string, payload?: Record<string, unknown>) => {
        info.push(message);
        fields.push(payload);
      },
      error: (message: string) => error.push(message),
    } as unknown as Parameters<typeof startLinearAppTokenRefresher>[0]['logger'],
    info,
    error,
    fields,
  };
}

function refresherEnv(): NodeJS.ProcessEnv {
  return { LINEAR_CLIENT_ID: 'cid', LINEAR_CLIENT_SECRET: 'csec' };
}
