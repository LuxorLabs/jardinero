import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createJwtSigner, proxyJwtClaims } from '../testing/proxy-jwt.js';
import {
  type ParsedProxyJwt,
  type ProxyJwtVerdict,
  fetchJwks,
  parseProxyJwt,
  verifyProxyJwt,
} from './proxy-jwt.js';

describe('parseProxyJwt', () => {
  const cases: Array<{ name: string; token: string; want: ParsedProxyJwt }> = [
    {
      name: 'When the token is not three segments then should refuse it as `malformed`',
      token: 'not-a-jwt',
      want: { refusal: 'malformed' },
    },
    {
      name: 'When the header is not JSON then should refuse it as `malformed`',
      token: 'bm90LWpzb24.e30.c2ln',
      want: { refusal: 'malformed' },
    },
    {
      name: 'When the header names `HS256` then should refuse it as `unsupported_algorithm`',
      token: 'eyJhbGciOiJIUzI1NiIsImtpZCI6ImVjLWtleSJ9.e30.c2ln',
      want: { refusal: 'unsupported_algorithm' },
    },
    {
      name: 'When the header names `toString` then should refuse it as `unsupported_algorithm`',
      token: 'eyJhbGciOiJ0b1N0cmluZyIsImtpZCI6ImVjLWtleSJ9.e30.c2ln',
      want: { refusal: 'unsupported_algorithm' },
    },
    {
      name: 'When the header names no algorithm then should refuse it as `unsupported_algorithm`',
      token: 'eyJraWQiOiJlYy1rZXkifQ.e30.c2ln',
      want: { refusal: 'unsupported_algorithm' },
    },
    {
      name: 'When the header names no `kid` then should refuse it as `missing_kid`',
      token: 'eyJhbGciOiJFUzI1NiJ9.e30.c2ln',
      want: { refusal: 'missing_kid' },
    },
    {
      name: 'When the header names a supported algorithm and a `kid` then should answer its parts',
      token: 'eyJhbGciOiJFUzI1NiIsImtpZCI6ImVjLWtleSJ9.e30.c2ln',
      want: {
        jwt: {
          alg: 'ES256',
          kid: 'ec-key',
          encodedHeader: 'eyJhbGciOiJFUzI1NiIsImtpZCI6ImVjLWtleSJ9',
          encodedPayload: 'e30',
          encodedSignature: 'c2ln',
        },
      },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.deepEqual(parseProxyJwt(testCase.token), testCase.want);
    });
  }
});

describe('verifyProxyJwt', () => {
  const signer = createJwtSigner('ec-key');
  const rsaSigner = createJwtSigner('rsa-key', 'RS256');
  const stranger = createJwtSigner('ec-key');
  const jwks = new Map([
    [signer.kid, signer.publicKey],
    [rsaSigner.kid, rsaSigner.publicKey],
  ]);
  const expected = { audience: 'jardinero.example.test', issuer: 'jardinero.example.test' };
  const now = Math.floor(Date.now() / 1000);

  const cases: Array<{ name: string; token: () => string; want: ProxyJwtVerdict }> = [
    {
      name: 'When the `kid` is not in the JWKS then should refuse it as `unknown_key`',
      token: () => signer.sign(proxyJwtClaims(), { kid: 'rotated-away' }),
      want: { refusal: 'unknown_key' },
    },
    {
      name: 'When `ES256` names an RSA key then should refuse it as `key_mismatch`',
      token: () => signer.sign(proxyJwtClaims(), { kid: 'rsa-key' }),
      want: { refusal: 'key_mismatch' },
    },
    {
      name: 'When another key signed it under the same `kid` then should refuse it as `bad_signature`',
      token: () => stranger.sign(proxyJwtClaims()),
      want: { refusal: 'bad_signature' },
    },
    {
      name: 'When the signed payload is not a JSON object then should refuse it as `malformed`',
      token: () => signer.sign('"just a string"'),
      want: { refusal: 'malformed' },
    },
    {
      name: 'When `aud` names another audience then should refuse it as `wrong_audience`',
      token: () => signer.sign(proxyJwtClaims({ aud: 'grafana.example.test' })),
      want: { refusal: 'wrong_audience' },
    },
    {
      name: 'When `iss` names another issuer then should refuse it as `wrong_issuer`',
      token: () => signer.sign(proxyJwtClaims({ iss: 'grafana.example.test' })),
      want: { refusal: 'wrong_issuer' },
    },
    {
      name: 'When `exp` is missing then should refuse it as `expired`',
      token: () => signer.sign(proxyJwtClaims({ exp: undefined })),
      want: { refusal: 'expired' },
    },
    {
      name: 'When `exp` passed more than the clock skew ago then should refuse it as `expired`',
      token: () => signer.sign(proxyJwtClaims({ exp: now - 61 })),
      want: { refusal: 'expired' },
    },
    {
      name: 'When `iat` is missing then should refuse it as `invalid_iat`',
      token: () => signer.sign(proxyJwtClaims({ iat: undefined })),
      want: { refusal: 'invalid_iat' },
    },
    {
      name: 'When `iat` is beyond the clock skew ahead then should refuse it as `invalid_iat`',
      token: () => signer.sign(proxyJwtClaims({ iat: now + 61 })),
      want: { refusal: 'invalid_iat' },
    },
    {
      name: 'When an `ES256` token is current then should answer its email and subject',
      token: () => signer.sign(proxyJwtClaims()),
      want: { identity: { email: 'operator@example.test', subject: 'operator-subject' } },
    },
    {
      name: 'When an `RS256` token is current then should answer its email and subject',
      token: () => rsaSigner.sign(proxyJwtClaims()),
      want: { identity: { email: 'operator@example.test', subject: 'operator-subject' } },
    },
    {
      name: 'When `aud` is a list naming the audience then should accept it',
      token: () =>
        signer.sign(proxyJwtClaims({ aud: ['other.example.test', 'jardinero.example.test'] })),
      want: { identity: { email: 'operator@example.test', subject: 'operator-subject' } },
    },
    {
      name: 'When `exp` passed within the clock skew then should accept it',
      token: () => signer.sign(proxyJwtClaims({ exp: now - 30 })),
      want: { identity: { email: 'operator@example.test', subject: 'operator-subject' } },
    },
    {
      name: 'When `email` and `sub` are missing then should accept it naming no one',
      token: () => signer.sign(proxyJwtClaims({ email: undefined, sub: '' })),
      want: { identity: { email: null, subject: null } },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const parsed = parseProxyJwt(testCase.token());
      assert.ok('jwt' in parsed);

      assert.deepEqual(verifyProxyJwt(parsed.jwt, jwks, expected, now), testCase.want);
    });
  }
});

describe('fetchJwks', () => {
  const ecKey = createJwtSigner('ec-key').jwksBody().keys[0];
  const rsaKey = createJwtSigner('rsa-key', 'RS256').jwksBody().keys[0];

  const cases: Array<{
    name: string;
    response: () => Response;
    want: { requested: string[]; kids?: string[]; error?: string };
  }> = [
    {
      name: 'When the JWKS url answers an error then should reject with its status',
      response: () => new Response('unavailable', { status: 503 }),
      want: {
        requested: ['https://jardinero.example.test/.well-known/pomerium/jwks.json'],
        error: 'JWKS request failed: 503',
      },
    },
    {
      name: 'When the body has no `keys` list then should reject for want of a signing key',
      response: () => Response.json({}),
      want: {
        requested: ['https://jardinero.example.test/.well-known/pomerium/jwks.json'],
        error: 'JWKS has no P-256 or RSA signing key',
      },
    },
    {
      name: 'When a key has no `kid` then should skip it',
      response: () => Response.json({ keys: [{ ...rsaKey, kid: undefined }, ecKey] }),
      want: {
        requested: ['https://jardinero.example.test/.well-known/pomerium/jwks.json'],
        kids: ['ec-key'],
      },
    },
    {
      name: 'When a key is neither P-256 nor RSA then should skip it',
      response: () =>
        Response.json({ keys: [{ kty: 'EC', crv: 'P-384', kid: 'p384-key', x: 'AA', y: 'AA' }] }),
      want: {
        requested: ['https://jardinero.example.test/.well-known/pomerium/jwks.json'],
        error: 'JWKS has no P-256 or RSA signing key',
      },
    },
    {
      name: 'When a P-256 key is malformed then should skip it and keep the others',
      response: () =>
        Response.json({
          keys: [{ kty: 'EC', crv: 'P-256', kid: 'bad-key', x: 'AA', y: 'AA' }, rsaKey],
        }),
      want: {
        requested: ['https://jardinero.example.test/.well-known/pomerium/jwks.json'],
        kids: ['rsa-key'],
      },
    },
    {
      name: 'When the JWKS holds a P-256 and an RSA key then should keep both by their `kid`',
      response: () => Response.json({ keys: [ecKey, rsaKey] }),
      want: {
        requested: ['https://jardinero.example.test/.well-known/pomerium/jwks.json'],
        kids: ['ec-key', 'rsa-key'],
      },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const requested: string[] = [];
      const fetchImpl: typeof fetch = async (input) => {
        requested.push(String(input));
        return testCase.response();
      };

      const outcome = await fetchJwks(
        fetchImpl,
        'https://jardinero.example.test/.well-known/pomerium/jwks.json',
      ).then(
        (jwks) => ({ requested, kids: [...jwks.keys()] }),
        (error: Error) => ({ requested, error: error.message }),
      );

      assert.deepEqual(outcome, testCase.want);
    });
  }
});
