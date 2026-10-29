import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AppConfig, ProxyJwtConfig } from '../config.js';
import { logger } from '../platform/logger.js';
import { nowMs } from '../platform/time.js';
import {
  type Jwks,
  type ProxyIdentity,
  fetchJwks,
  parseProxyJwt,
  verifyProxyJwt,
} from './proxy-jwt.js';
import { headerValue } from './request.js';
import { sendJson } from './respond.js';

export interface AuthContext {
  config: AppConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const log = logger.child('auth');

// JWKS_TTL_MS is how long fetched keys are used before the JWKS is fetched again.
const JWKS_TTL_MS = 5 * 60_000;
// JWKS_MIN_REFETCH_MS is the shortest gap between fetches an unknown `kid` triggers, so tokens
// with invented ones cannot cause a fetch per request.
const JWKS_MIN_REFETCH_MS = 30_000;

const jwksFetches = new WeakMap<AuthContext, { fetchedAtMs: number; jwks: Promise<Jwks> }>();
const goodJwks = new WeakMap<AuthContext, Jwks>();
const operatorIdentities = new WeakMap<IncomingMessage, ProxyIdentity>();

// requireAdmin answers the 401 itself because it guards the router, not a handler:
// nothing downstream should have to remember to check a boolean first.
export function requireAdmin(
  context: AuthContext,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const env = context.env ?? process.env;
  const token = env[context.config.auth.adminTokenEnv];
  if (!token) {
    sendJson(response, 401, { error: 'admin_token_not_configured' });
    return false;
  }
  const authorization = headerValue(request.headers.authorization);
  if (authorization && constantTimeEquals(authorization, `Bearer ${token}`)) return true;
  sendJson(response, 401, { error: 'unauthorized' });
  return false;
}

// requireOperator lets a request through only when it carries a JWT the proxy signed, or
// when `auth.proxy_jwt` is not configured.
export async function requireOperator(
  context: AuthContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const proxyJwt = context.config.auth.proxyJwt;
  if (!proxyJwt) return true;
  const token = headerValue(request.headers[proxyJwt.header.toLowerCase()]);
  if (!token) {
    sendJson(response, 401, { error: 'unauthorized' });
    return false;
  }
  const parsed = parseProxyJwt(token);
  if ('refusal' in parsed) {
    log.warn('proxy jwt refused', { reason: parsed.refusal });
    sendJson(response, 401, { error: 'unauthorized' });
    return false;
  }
  const jwks = await currentJwks(context, proxyJwt, false);
  if (!jwks) {
    sendJson(response, 503, { error: 'proxy_jwks_unavailable' });
    return false;
  }
  const nowSeconds = Math.floor(nowMs() / 1000);
  let verdict = verifyProxyJwt(parsed.jwt, jwks, proxyJwt, nowSeconds);
  // Fetch again: the proxy may have rotated its key since the cached JWKS was fetched.
  if ('refusal' in verdict && verdict.refusal === 'unknown_key') {
    const refetched = (await currentJwks(context, proxyJwt, true)) ?? jwks;
    verdict = verifyProxyJwt(parsed.jwt, refetched, proxyJwt, nowSeconds);
  }
  if ('refusal' in verdict) {
    log.warn('proxy jwt refused', { reason: verdict.refusal });
    sendJson(response, 401, { error: 'unauthorized' });
    return false;
  }
  operatorIdentities.set(request, verdict.identity);
  return true;
}

// operatorIdentity is who requireOperator verified the request came from; undefined while
// `auth.proxy_jwt` is not configured.
export function operatorIdentity(request: IncomingMessage): ProxyIdentity | undefined {
  return operatorIdentities.get(request);
}

// currentJwks returns the cached or freshly fetched JWKS, or the last good one when the fetch
// fails; undefined only until a fetch first succeeds.
async function currentJwks(
  context: AuthContext,
  proxyJwt: ProxyJwtConfig,
  refetch: boolean,
): Promise<Jwks | undefined> {
  try {
    return await cachedJwks(context, proxyJwt, refetch);
  } catch {
    return goodJwks.get(context);
  }
}

// cachedJwks shares one fetch among concurrent requests and records the key set each
// successful one returns.
function cachedJwks(
  context: AuthContext,
  proxyJwt: ProxyJwtConfig,
  refetch: boolean,
): Promise<Jwks> {
  const cached = jwksFetches.get(context);
  const maxAgeMs = refetch ? JWKS_MIN_REFETCH_MS : JWKS_TTL_MS;
  if (cached && nowMs() - cached.fetchedAtMs < maxAgeMs) return cached.jwks;
  const entry = {
    fetchedAtMs: nowMs(),
    jwks: fetchJwks(context.fetchImpl ?? fetch, proxyJwt.jwksUrl),
  };
  jwksFetches.set(context, entry);
  entry.jwks.then(
    (jwks) => goodJwks.set(context, jwks),
    (error) => {
      log.error('proxy jwks fetch failed', { jwks_url: proxyJwt.jwksUrl, error: String(error) });
      // Forget the failed fetch while no key set is known, so the next request retries at once
      // instead of answering 503 for the rest of the TTL.
      if (!goodJwks.has(context) && jwksFetches.get(context) === entry) {
        jwksFetches.delete(context);
      }
    },
  );
  return entry.jwks;
}

// constantTimeEquals compares the bearer token without leaking its length or prefix
// through timing. Length is compared first, since timingSafeEqual needs equal-length
// buffers.
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
