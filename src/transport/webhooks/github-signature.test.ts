import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';

import { verifyGitHubSignature } from './github-signature.js';

const SECRET = 'ghsecret';
const BODY = '{"action":"opened"}';

describe('verifyGitHubSignature', () => {
  const cases: Array<{
    name: string;
    secret?: string;
    body?: string;
    header: (body: string) => string | null;
    want: boolean;
  }> = [
    {
      name: 'When secret is missing then should return error',
      secret: undefined,
      header: sign(SECRET),
      want: false,
    },
    {
      name: 'When header is missing then should return error',
      header: () => null,
      want: false,
    },
    {
      name: 'When header has no sha256 prefix then should return error',
      header: (body) => createHmac('sha256', SECRET).update(body).digest('hex'),
      want: false,
    },
    {
      name: 'When header uses another algorithm prefix then should return error',
      header: (body) => `sha1=${createHmac('sha1', SECRET).update(body).digest('hex')}`,
      want: false,
    },
    {
      // Shorter than a sha256 digest, so the comparison short-circuits on length.
      name: 'When digest length differs then should return error',
      header: () => 'sha256=deadbeef',
      want: false,
    },
    {
      // Same length as a real digest, so the constant-time comparison runs.
      name: 'When digest differs then should return error',
      header: () => `sha256=${'deadbeef'.repeat(8)}`,
      want: false,
    },
    {
      name: 'When secret is wrong then should return error',
      header: sign('other-secret'),
      want: false,
    },
    {
      name: 'When body differs from the signed one then should return error',
      header: sign(SECRET, '{"action":"closed"}'),
      want: false,
    },
    {
      name: 'When signature matches then should validate successfully',
      header: sign(SECRET),
      want: true,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const body = c.body ?? BODY;

      const verified = verifyGitHubSignature(
        'secret' in c ? c.secret : SECRET,
        Buffer.from(body),
        c.header(body),
      );

      assert.equal(verified, c.want);
    });
  }
});

function sign(secret: string, over?: string): (body: string) => string {
  return (body) =>
    `sha256=${createHmac('sha256', secret)
      .update(over ?? body)
      .digest('hex')}`;
}
