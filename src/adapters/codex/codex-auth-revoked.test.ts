import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CODEX_AUTH_REVOKED,
  CODEX_AUTH_REVOKED_MESSAGE,
  codexAuthIsBlocked,
  isCodexAuthRevokedError,
  isCodexAuthRevokedOutput,
  recordCodexAuthRevoked,
} from './codex-auth-revoked.js';

describe('isCodexAuthRevokedOutput', () => {
  const cases: Array<{ name: string; result: Record<string, string>; want: boolean }> = [
    {
      name: 'When stdout names workspace routing discovery unauthorized then should be revoked',
      result: { stdout: 'workspace routing discovery unauthorized (401)' },
      want: true,
    },
    {
      name: 'When stderr names `invalid_grant` then should be revoked',
      result: { stderr: 'Token endpoint answered 400: invalid_grant' },
      want: true,
    },
    {
      name: 'When the last message names the 401 then should be revoked',
      result: { lastMessage: 'workspace routing discovery unauthorized (401)' },
      want: true,
    },
    {
      name: 'When the failure is another one then should not be revoked',
      result: { stderr: 'error: repository checkout failed' },
      want: false,
    },
    {
      name: 'When there is no output then should not be revoked',
      result: {},
      want: false,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(isCodexAuthRevokedOutput(c.result), c.want);
    });
  }
});

describe('isCodexAuthRevokedError', () => {
  const cases: Array<{ name: string; error: string | undefined; want: boolean }> = [
    {
      name: 'When the error is `codex_auth_revoked` then should match',
      error: CODEX_AUTH_REVOKED,
      want: true,
    },
    {
      name: 'When the error is a different Codex failure then should not match',
      error: 'codex_exec_failed',
      want: false,
    },
    {
      name: 'When there is no error then should not match',
      error: undefined,
      want: false,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(isCodexAuthRevokedError(c.error), c.want);
    });
  }
});

describe('codexAuthIsBlocked', () => {
  const cases: Array<{
    name: string;
    block:
      | { reason: string; authFingerprint: string; createdAt: number; updatedAt: number }
      | undefined;
    fingerprint: string;
    want: boolean;
    wantCleared: boolean;
  }> = [
    {
      name: 'When nothing is stored then should not be blocked',
      block: undefined,
      fingerprint: 'live',
      want: false,
      wantCleared: false,
    },
    {
      name: 'When the stored fingerprint still matches then should stay blocked',
      block: {
        reason: CODEX_AUTH_REVOKED,
        authFingerprint: 'dead',
        createdAt: 1,
        updatedAt: 1,
      },
      fingerprint: 'dead',
      want: true,
      wantCleared: false,
    },
    {
      name: 'When auth.json has a new fingerprint then should clear the block',
      block: {
        reason: CODEX_AUTH_REVOKED,
        authFingerprint: 'dead',
        createdAt: 1,
        updatedAt: 1,
      },
      fingerprint: 'fresh',
      want: false,
      wantCleared: true,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      let stored = c.block;
      const store = {
        getHostBlock: () => stored,
        clearHostBlock: () => {
          stored = undefined;
        },
      };

      assert.equal(codexAuthIsBlocked(store, c.fingerprint), c.want);
      assert.equal(stored === undefined, c.block === undefined || c.wantCleared);
    });
  }
});

describe('recordCodexAuthRevoked', () => {
  test('When Codex login dies then should store the host block', () => {
    const stored: { reason?: string; authFingerprint?: string } = {};
    recordCodexAuthRevoked({
      setHostBlock: (fields) => {
        stored.reason = fields.reason;
        stored.authFingerprint = fields.authFingerprint;
      },
    });

    assert.equal(stored.reason, CODEX_AUTH_REVOKED);
    assert.equal(typeof stored.authFingerprint, 'string');
  });
});

test('When the write-back message is read then should tell the operator to relogin', () => {
  assert.match(CODEX_AUTH_REVOKED_MESSAGE, /codex login/);
  assert.match(CODEX_AUTH_REVOKED_MESSAGE, /auth\.json/);
});
