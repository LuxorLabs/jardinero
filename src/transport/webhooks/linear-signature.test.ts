import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';

import { isFreshLinearWebhookTimestamp, verifyLinearSignature } from './linear-signature.js';

const NOW = 1_750_000_000_000;

describe('verifyLinearSignature', () => {
  const signatureCases = [
    {
      name: 'When signature matches then should validate successfully',
      secret: 'linsecret',
      body: '{"type":"AgentSessionEvent"}',
      header: (body: string) => createHmac('sha256', 'linsecret').update(body).digest('hex'),
      want: true,
    },
    {
      // Same length as a sha256 hex digest, so the comparison actually runs.
      name: 'When digest differs then should return error',
      secret: 'linsecret',
      body: '{"type":"AgentSessionEvent"}',
      header: () => 'deadbeef'.repeat(8),
      want: false,
    },
    {
      name: 'When header length differs then should return error',
      secret: 'linsecret',
      body: '{"type":"AgentSessionEvent"}',
      header: () => 'deadbeef',
      want: false,
    },
    {
      name: 'When secret is wrong then should return error',
      secret: 'linsecret',
      body: '{"type":"AgentSessionEvent"}',
      header: (body: string) => createHmac('sha256', 'other-secret').update(body).digest('hex'),
      want: false,
    },
    {
      name: 'When secret is missing then should return error',
      secret: undefined,
      body: '{}',
      header: (body: string) => createHmac('sha256', 'linsecret').update(body).digest('hex'),
      want: false,
    },
    {
      name: 'When header is missing then should return error',
      secret: 'linsecret',
      body: '{}',
      header: () => null,
      want: false,
    },
  ];

  for (const c of signatureCases) {
    test(c.name, () => {
      assert.equal(verifyLinearSignature(c.secret, Buffer.from(c.body), c.header(c.body)), c.want);
    });
  }
});

describe('isFreshLinearWebhookTimestamp', () => {
  const freshnessCases: Array<{
    name: string;
    timestamp: unknown;
    toleranceMs?: number;
    want: boolean;
  }> = [
    {
      name: 'When timestamp is not a number then should return error',
      timestamp: 'now',
      want: false,
    },
    {
      name: 'When timestamp is missing then should return error',
      timestamp: undefined,
      want: false,
    },
    {
      name: 'When timestamp is nan then should return error',
      timestamp: Number.NaN,
      want: false,
    },
    {
      name: 'When timestamp is infinite then should return error',
      timestamp: Number.POSITIVE_INFINITY,
      want: false,
    },
    {
      name: 'When timestamp is recent then should validate successfully',
      timestamp: NOW - 30_000,
      want: true,
    },
    {
      name: 'When timestamp is slightly in the future then should validate successfully',
      timestamp: NOW + 30_000,
      want: true,
    },
    {
      name: 'When timestamp sits exactly on the tolerance then should validate successfully',
      timestamp: NOW - 60_000,
      want: true,
    },
    {
      name: 'When timestamp is too old then should return error',
      timestamp: NOW - 61_000,
      want: false,
    },
    {
      name: 'When timestamp is too far in the future then should return error',
      timestamp: NOW + 61_000,
      want: false,
    },
    {
      name: 'When a tolerance is given then should judge freshness against it',
      timestamp: NOW - 5_000,
      toleranceMs: 1_000,
      want: false,
    },
  ];

  for (const c of freshnessCases) {
    test(c.name, () => {
      assert.equal(isFreshLinearWebhookTimestamp(c.timestamp, NOW, c.toleranceMs), c.want);
    });
  }
});
