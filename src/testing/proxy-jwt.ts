import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';

import type { ProxyJwtConfig } from '../config.js';

// JwtSigner stands in for the key an authenticating proxy signs its JWTs with, and its JWKS.
export interface JwtSigner {
  kid: string;
  publicKey: KeyObject;
  sign(claims: Record<string, unknown> | string, header?: Record<string, unknown>): string;
  jwksBody(): { keys: Array<Record<string, unknown>> };
}

export const PROXY_JWT: ProxyJwtConfig = {
  header: 'X-Pomerium-Jwt-Assertion',
  jwksUrl: 'https://jardinero.example.test/.well-known/pomerium/jwks.json',
  audience: 'jardinero.example.test',
  issuer: 'jardinero.example.test',
};

export function createJwtSigner(
  kid = 'proxy-test-key',
  alg: 'ES256' | 'RS256' = 'ES256',
): JwtSigner {
  const { privateKey, publicKey } =
    alg === 'ES256'
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    kid,
    publicKey,
    sign(claims, header = {}) {
      const encodedHeader = segment(JSON.stringify({ alg, kid, typ: 'JWT', ...header }));
      const encodedPayload = segment(typeof claims === 'string' ? claims : JSON.stringify(claims));
      const signature = sign('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
      });
      return `${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`;
    },
    jwksBody() {
      return { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' }] };
    },
  };
}

// proxyJwtClaims returns the claims a proxy writes for PROXY_JWT, valid for five minutes.
export function proxyJwtClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: PROXY_JWT.audience,
    iss: PROXY_JWT.issuer,
    iat: now,
    exp: now + 300,
    sub: 'operator-subject',
    email: 'operator@example.test',
    ...overrides,
  };
}

// jwksFetch answers the JWKS at PROXY_JWT.jwksUrl and nothing else.
export function jwksFetch(signer: JwtSigner): typeof fetch {
  return async (input) => {
    if (String(input) !== PROXY_JWT.jwksUrl) return new Response('not found', { status: 404 });
    return Response.json(signer.jwksBody());
  };
}

function segment(json: string): string {
  return Buffer.from(json).toString('base64url');
}
