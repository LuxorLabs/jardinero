import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AppConfig } from '../config.js';
import { headerValue } from './request.js';
import { sendJson } from './respond.js';

export interface AuthContext {
  config: AppConfig;
  env?: NodeJS.ProcessEnv;
}

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

// constantTimeEquals compares the bearer token without leaking its length or prefix
// through timing. Length is compared first, since timingSafeEqual needs equal-length
// buffers.
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
