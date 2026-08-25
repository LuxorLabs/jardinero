import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, test } from 'node:test';

import { isFreshDiscordInteractionTimestamp, verifyDiscordSignature } from './discord-signature.js';

describe('verifyDiscordSignature', () => {
  const signed = signInteraction('1700000000', '{"type":1}');

  const cases: Array<{
    name: string;
    publicKeyHex: string | undefined;
    signature: string | null;
    timestamp: string | null;
    body?: Buffer;
    wantValid: boolean;
  }> = [
    {
      name: 'When the signature matches the timestamp and body then should accept the interaction',
      publicKeyHex: signed.publicKeyHex,
      signature: signed.signature,
      timestamp: signed.timestamp,
      wantValid: true,
    },
    {
      name: 'When the public key is unset then should reject the interaction',
      publicKeyHex: undefined,
      signature: signed.signature,
      timestamp: signed.timestamp,
      wantValid: false,
    },
    {
      name: 'When the signature header is absent then should reject the interaction',
      publicKeyHex: signed.publicKeyHex,
      signature: null,
      timestamp: signed.timestamp,
      wantValid: false,
    },
    {
      name: 'When the timestamp header is absent then should reject the interaction',
      publicKeyHex: signed.publicKeyHex,
      signature: signed.signature,
      timestamp: null,
      wantValid: false,
    },
    {
      name: 'When the public key is not 32 bytes then should reject the interaction',
      publicKeyHex: 'ab'.repeat(16),
      signature: signed.signature,
      timestamp: signed.timestamp,
      wantValid: false,
    },
    {
      name: 'When the signature is not 64 bytes then should reject the interaction',
      publicKeyHex: signed.publicKeyHex,
      signature: 'ab'.repeat(32),
      timestamp: signed.timestamp,
      wantValid: false,
    },
    {
      name: 'When the public key is not hex then should reject the interaction',
      publicKeyHex: 'z'.repeat(64),
      signature: signed.signature,
      timestamp: signed.timestamp,
      wantValid: false,
    },
    {
      name: 'When the signature is not hex then should reject the interaction',
      publicKeyHex: signed.publicKeyHex,
      signature: 'z'.repeat(128),
      timestamp: signed.timestamp,
      wantValid: false,
    },
    {
      name: 'When the body was tampered with then should reject the interaction',
      publicKeyHex: signed.publicKeyHex,
      signature: signed.signature,
      timestamp: signed.timestamp,
      body: Buffer.from('{"type":2}'),
      wantValid: false,
    },
    {
      name: 'When the timestamp was tampered with then should reject the interaction',
      publicKeyHex: signed.publicKeyHex,
      signature: signed.signature,
      timestamp: '1700000001',
      wantValid: false,
    },
    {
      name: 'When the signature came from another key then should reject the interaction',
      publicKeyHex: signed.publicKeyHex,
      signature: signInteraction('1700000000', '{"type":1}').signature,
      timestamp: signed.timestamp,
      wantValid: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(
        verifyDiscordSignature(
          testCase.publicKeyHex,
          testCase.body ?? signed.body,
          testCase.signature,
          testCase.timestamp,
        ),
        testCase.wantValid,
      );
    });
  }
});

describe('isFreshDiscordInteractionTimestamp', () => {
  const nowMs = 1_700_000_000_000;

  const cases: Array<{
    name: string;
    timestamp: string | null;
    toleranceMs?: number;
    wantFresh: boolean;
  }> = [
    { name: 'the timestamp is absent', timestamp: null, wantFresh: false },
    { name: 'the timestamp is not a number', timestamp: 'not-a-number', wantFresh: false },
    { name: 'the timestamp is now', timestamp: '1700000000', wantFresh: true },
    { name: 'the timestamp is within tolerance', timestamp: '1699999900', wantFresh: true },
    { name: 'the timestamp is far in the past', timestamp: '1699000000', wantFresh: false },
    { name: 'the timestamp is far in the future', timestamp: '1701000000', wantFresh: false },
    {
      name: 'the given tolerance excludes a recent timestamp',
      timestamp: '1699999900',
      toleranceMs: 1_000,
      wantFresh: false,
    },
  ];

  for (const testCase of cases) {
    test(`When ${testCase.name} then should ${testCase.wantFresh ? 'accept' : 'reject'} the timestamp`, () => {
      assert.equal(
        testCase.toleranceMs === undefined
          ? isFreshDiscordInteractionTimestamp(testCase.timestamp, nowMs)
          : isFreshDiscordInteractionTimestamp(testCase.timestamp, nowMs, testCase.toleranceMs),
        testCase.wantFresh,
      );
    });
  }
});

interface SignedInteraction {
  publicKeyHex: string;
  signature: string;
  timestamp: string;
  body: Buffer;
}

function signInteraction(timestamp: string, rawBody: string): SignedInteraction {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const body = Buffer.from(rawBody);
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp, 'utf8'), body]), privateKey);
  return {
    publicKeyHex: Buffer.from(jwk.x, 'base64url').toString('hex'),
    signature: signature.toString('hex'),
    timestamp,
    body,
  };
}
