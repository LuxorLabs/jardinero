import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';

import { terminateTenkiSessionInChild } from './tenki-terminate.js';

// Termination runs in a child process so a hung SDK call can be killed without
// taking the orchestrator with it. These cases drive the real child; the resolve
// arm needs a live Tenki session and is covered by the smoke script instead.
describe('terminateTenkiSessionInChild', () => {
  const cases: Array<{
    name: string;
    sessionId?: string;
    options?: { cwd?: string; authToken?: string; baseUrl?: string; timeoutMs?: number };
    wantError: RegExp;
  }> = [
    {
      // A closed port proves the base url reached the SDK, and getting as far as
      // connecting proves the token did too; the SDK rejects a missing one first,
      // and rejects any token not prefixed tk_ before it opens a connection.
      name: 'When the auth token and base url are given then should pass both to the child',
      options: { authToken: 'tk_token-from-options', baseUrl: 'http://127.0.0.1:1' },
      wantError: /ECONNREFUSED 127\.0\.0\.1:1/,
    },
    {
      // The child resolves `@tenkicloud/sandbox` against its cwd, so a cwd outside
      // the repo is what makes the SDK unresolvable.
      name: 'When a cwd is given then should run the child in it',
      options: { cwd: tmpdir() },
      wantError: /ERR_MODULE_NOT_FOUND/,
    },
    {
      name: 'When the child fails then should return error with its code and stderr',
      sessionId: '',
      wantError:
        /Failed to terminate Tenki sandbox session \(code=1, signal=none\).*Missing session id/s,
    },
    {
      name: 'When the child outlives the timeout then should return error naming it',
      options: { timeoutMs: 1 },
      wantError: /Timed out terminating Tenki sandbox session after 1ms\./,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      await assert.rejects(
        () =>
          terminateTenkiSessionInChild(testCase.sessionId ?? 'sess-1', {
            timeoutMs: 20_000,
            ...testCase.options,
          }),
        testCase.wantError,
      );
    });
  }
});
