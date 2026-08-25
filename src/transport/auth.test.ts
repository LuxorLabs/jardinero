import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { describe, test } from 'node:test';

import { loadConfig } from '../config.js';
import { type AuthContext, constantTimeEquals, requireAdmin } from './auth.js';

describe('requireAdmin', () => {
  const cases: Array<{
    name: string;
    token?: string;
    authorization?: string | string[];
    want: boolean;
    wantError?: string;
  }> = [
    {
      // Without a configured token every caller would be an admin, so the guard
      // refuses instead of defaulting open.
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
      // A repeated header resolves to its first value, never a join.
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

describe('constantTimeEquals', () => {
  const cases: Array<{ name: string; a: string; b: string; want: boolean }> = [
    { name: 'When both values match then should return true', a: 'abc', b: 'abc', want: true },
    { name: 'When the values differ then should return false', a: 'abc', b: 'abd', want: false },
    // Lengths are compared first because timingSafeEqual requires equal-length
    // buffers; the length itself is not secret.
    { name: 'When the lengths differ then should return false', a: 'abc', b: 'abcd', want: false },
    { name: 'When both values are empty then should return true', a: '', b: '', want: true },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(constantTimeEquals(testCase.a, testCase.b), testCase.want);
    });
  }
});
