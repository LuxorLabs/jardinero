import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CODEX_AUTH_REVOKED_MESSAGE } from '../adapters/codex/codex-auth-revoked.js';
import { loadConfig } from '../config.js';
import { LinearSessions } from './linear-sessions.js';

describe('LinearSessions.reportCodexAuthRevoked', () => {
  const cases: Array<{
    name: string;
    token?: string;
    fetchImpl?: typeof fetch;
    wantError?: RegExp;
    wantBody?: boolean;
  }> = [
    {
      name: 'When the token is missing then should answer the error',
      wantError: /missing linear api token/,
    },
    {
      name: 'When Linear accepts the activity then should write the relogin error',
      token: 'tok',
      wantBody: true,
    },
    {
      name: 'When Linear refuses the activity then should answer the error',
      token: 'tok',
      fetchImpl: (async () => {
        throw new Error('Linear GraphQL 401');
      }) as typeof fetch,
      wantError: /Linear GraphQL 401/,
    },
    {
      name: 'When Linear throws a non-Error then should wrap it',
      token: 'tok',
      fetchImpl: (async () => {
        throw 'nope';
      }) as typeof fetch,
      wantError: /^nope$/,
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const captured: { url?: string; init?: RequestInit } = {};
      const config = loadConfig();
      const fetchImpl =
        c.fetchImpl ??
        (async (input, init) => {
          captured.url = typeof input === 'string' ? input : input.toString();
          captured.init = init;
          return new Response(
            JSON.stringify({ data: { agentActivityCreate: { success: true } } }),
            {
              status: 200,
            },
          );
        });
      const linear = new LinearSessions(
        config,
        c.token ? { [config.workflows.linearImplementer.apiTokenEnv]: c.token } : {},
        fetchImpl,
      );

      const error = await linear.reportCodexAuthRevoked('session-1');

      if (c.wantError) {
        assert.match(error?.message ?? '', c.wantError);
        return;
      }
      assert.equal(error, undefined);
      if (c.wantBody) {
        assert.match(String(captured.init?.body), /agentSessionId/);
        assert.match(String(captured.init?.body), /session-1/);
        assert.match(
          String(captured.init?.body),
          new RegExp(CODEX_AUTH_REVOKED_MESSAGE.slice(0, 20)),
        );
      }
    });
  }
});
