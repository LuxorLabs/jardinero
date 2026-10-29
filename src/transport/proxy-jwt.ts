import { type KeyObject, createPublicKey, verify, type webcrypto } from 'node:crypto';

export interface ProxyIdentity {
  email: string | null;
  subject: string | null;
}

export type ProxyJwtVerdict = { identity: ProxyIdentity } | { refusal: string };

export type Jwks = Map<string, KeyObject>;

const CLOCK_SKEW_SECONDS = 60;
const JWKS_FETCH_TIMEOUT_MS = 5_000;

// ALGORITHMS binds each algorithm proxies sign with to its key type, so a token cannot pick
// how its own signature is checked.
const ALGORITHMS = {
  ES256: { keyType: 'ec', dsaEncoding: 'ieee-p1363' },
  RS256: { keyType: 'rsa', dsaEncoding: undefined },
} as const;

type Algorithm = keyof typeof ALGORITHMS;

// ProxyJwt is a parsed token whose shape, algorithm and key id are already checked.
export interface ProxyJwt {
  alg: Algorithm;
  kid: string;
  encodedHeader: string;
  encodedPayload: string;
  encodedSignature: string;
}

export type ParsedProxyJwt = { jwt: ProxyJwt } | { refusal: string };

// parseProxyJwt refuses a token no JWKS could verify, so it never costs a fetch.
export function parseProxyJwt(token: string): ParsedProxyJwt {
  const parts = token.split('.');
  if (parts.length !== 3) return { refusal: 'malformed' };
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJsonSegment(encodedHeader);
  if (!header) return { refusal: 'malformed' };
  const alg = header.alg;
  if (typeof alg !== 'string' || !Object.hasOwn(ALGORITHMS, alg)) {
    return { refusal: 'unsupported_algorithm' };
  }
  if (typeof header.kid !== 'string') return { refusal: 'missing_kid' };
  return {
    jwt: {
      alg: alg as Algorithm,
      kid: header.kid,
      encodedHeader,
      encodedPayload,
      encodedSignature,
    },
  };
}

// verifyProxyJwt accepts only a current token signed by a JWKS key for this audience and issuer.
export function verifyProxyJwt(
  jwt: ProxyJwt,
  jwks: Jwks,
  expected: { audience: string; issuer: string },
  nowSeconds: number,
): ProxyJwtVerdict {
  const { encodedHeader, encodedPayload, encodedSignature } = jwt;
  const algorithm = ALGORITHMS[jwt.alg];
  const key = jwks.get(jwt.kid);
  if (!key) return { refusal: 'unknown_key' };
  if (key.asymmetricKeyType !== algorithm.keyType) return { refusal: 'key_mismatch' };
  const signed = verify(
    'sha256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    { key, dsaEncoding: algorithm.dsaEncoding },
    Buffer.from(encodedSignature, 'base64url'),
  );
  if (!signed) return { refusal: 'bad_signature' };
  const claims = decodeJsonSegment(encodedPayload);
  if (!claims) return { refusal: 'malformed' };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.audience)) return { refusal: 'wrong_audience' };
  if (claims.iss !== expected.issuer) return { refusal: 'wrong_issuer' };
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= nowSeconds) {
    return { refusal: 'expired' };
  }
  if (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
    return { refusal: 'invalid_iat' };
  }
  return { identity: { email: nonEmptyString(claims.email), subject: nonEmptyString(claims.sub) } };
}

// fetchJwks reads the signing keys a proxy publishes, keeping only P-256 and RSA keys by `kid`.
export async function fetchJwks(fetchImpl: typeof fetch, url: string): Promise<Jwks> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    // Time out the fetch: a request is waiting on it, and a stalled proxy must not hold it open.
    signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`JWKS request failed: ${response.status}`);
  const body = (await response.json()) as { keys?: unknown };
  const jwks: Jwks = new Map();
  for (const entry of Array.isArray(body.keys) ? body.keys : []) {
    const jwk = entry as webcrypto.JsonWebKey & { kid?: unknown };
    if (typeof jwk.kid !== 'string') continue;
    if (!(jwk.kty === 'EC' && jwk.crv === 'P-256') && jwk.kty !== 'RSA') continue;
    // Skip a malformed key instead of failing the whole JWKS.
    try {
      jwks.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    } catch {}
  }
  if (jwks.size === 0) throw new Error('JWKS has no P-256 or RSA signing key');
  return jwks;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function decodeJsonSegment(segment: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
