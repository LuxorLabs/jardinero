import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { oauthClientIdOf, refreshCodexAuth } from './codex-auth-refresh.js';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ID_TOKEN = jwtWithAudience(CLIENT_ID);

describe('refreshCodexAuth', () => {
  const cases: Array<{
    name: string;
    contents: string;
    response?: { status?: number; body: unknown };
    wantError?: RegExp;
    wantTokens?: Record<string, string>;
  }> = [
    {
      name: 'When the file is not JSON then should return error',
      contents: 'nope',
      wantError: /auth\.json is not valid JSON/,
    },
    {
      name: 'When the file is not an object then should return error',
      contents: '["tokens"]',
      wantError: /auth\.json is not a JSON object/,
    },
    {
      name: 'When there is no refresh token then should return error naming the login',
      contents: JSON.stringify({ tokens: { id_token: ID_TOKEN } }),
      wantError: /needs a ChatGPT login/,
    },
    {
      name: 'When there is no id token then should return error naming the login',
      contents: JSON.stringify({ tokens: { refresh_token: 'r-old' } }),
      wantError: /needs a ChatGPT login/,
    },
    {
      name: 'When the endpoint refuses then should return error with its status and body',
      contents: authFile(),
      response: { status: 400, body: { error: 'invalid_grant' } },
      wantError: /Token endpoint answered 400: .*invalid_grant/,
    },
    {
      name: 'When the endpoint answers without tokens then should return error naming the revocation',
      contents: authFile(),
      response: { body: { access_token: 'a-new' } },
      wantError: /likely revoked/,
    },
    {
      name: 'When the endpoint returns the same access token then should return error',
      contents: authFile(),
      response: { body: { access_token: 'a-old', id_token: 'i-new' } },
      wantError: /nothing rotated/,
    },
    {
      name: 'When the endpoint mints a new bundle then should carry all three tokens',
      contents: authFile(),
      response: { body: { access_token: 'a-new', id_token: 'i-new', refresh_token: 'r-new' } },
      wantTokens: { access_token: 'a-new', id_token: 'i-new', refresh_token: 'r-new' },
    },
    {
      // Losing the refresh token would lock the next run out of the account.
      name: 'When the endpoint omits the refresh token then should keep the one it was given',
      contents: authFile(),
      response: { body: { access_token: 'a-new', id_token: 'i-new' } },
      wantTokens: { access_token: 'a-new', id_token: 'i-new', refresh_token: 'r-old' },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const deps = {
        fetchImpl: stubFetch(testCase.response),
        now: () => new Date('2026-08-25T08:00:00.000Z'),
      };

      if (testCase.wantError) {
        await assert.rejects(() => refreshCodexAuth(testCase.contents, deps), testCase.wantError);
        return;
      }

      const written = JSON.parse(await refreshCodexAuth(testCase.contents, deps));
      assert.deepEqual(written.tokens, testCase.wantTokens);
      assert.equal(written.last_refresh, '2026-08-25T08:00:00Z');
    });
  }

  test('When the file carries other keys then should leave them untouched', async () => {
    const contents = JSON.stringify({ OPENAI_API_KEY: null, tokens: tokens(), extra: 'keep me' });

    const written = JSON.parse(
      await refreshCodexAuth(contents, {
        fetchImpl: stubFetch({ body: { access_token: 'a-new', id_token: 'i-new' } }),
      }),
    );

    assert.equal(written.extra, 'keep me');
    assert.equal(written.OPENAI_API_KEY, null);
  });

  test('When it refreshes then should send the client the id token names', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      sentBody = JSON.parse(String(init?.body));
      return Response.json({ access_token: 'a-new', id_token: 'i-new' });
    };

    await refreshCodexAuth(authFile(), { fetchImpl });

    assert.deepEqual(sentBody, {
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: 'r-old',
      scope: 'openid profile email',
    });
  });
});

describe('oauthClientIdOf', () => {
  const cases: Array<{ name: string; idToken: string; want?: string; wantError?: RegExp }> = [
    {
      name: 'When the audience is a string then should answer it',
      idToken: ID_TOKEN,
      want: CLIENT_ID,
    },
    {
      name: 'When the audience is a list then should answer the first',
      idToken: jwtWithAudience(['first', 'second']),
      want: 'first',
    },
    {
      name: 'When the token is not a JWT then should return error',
      idToken: 'not-a-jwt',
      wantError: /not a JWT/,
    },
    {
      name: 'When the payload is not decodable then should return error',
      idToken: 'header.@@@.signature',
      wantError: /Could not decode the id_token payload/,
    },
    {
      name: 'When there is no audience then should return error',
      idToken: jwtWithAudience(undefined),
      wantError: /Could not read the OAuth client/,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      if (testCase.wantError) {
        assert.throws(() => oauthClientIdOf(testCase.idToken), testCase.wantError);
        return;
      }
      assert.equal(oauthClientIdOf(testCase.idToken), testCase.want);
    });
  }
});

function jwtWithAudience(aud: string | string[] | undefined): string {
  const payload = Buffer.from(JSON.stringify(aud === undefined ? {} : { aud })).toString(
    'base64url',
  );
  return `header.${payload}.signature`;
}

function tokens(): Record<string, string> {
  return { access_token: 'a-old', id_token: ID_TOKEN, refresh_token: 'r-old' };
}

function authFile(): string {
  return JSON.stringify({ tokens: tokens() });
}

function stubFetch(response?: { status?: number; body: unknown }): typeof fetch {
  return async () =>
    Response.json(response?.body ?? {}, { status: response?.status ?? 200 }) as Response;
}
