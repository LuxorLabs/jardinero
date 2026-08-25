import { type Server, createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { logger } from '../platform/logger.js';
import { nowMs } from '../platform/time.js';
import { adminResponse } from './admin/admin.js';
import { requireAdmin } from './auth.js';
import { readRawBody } from './request.js';
import { capsuleResponse } from './capsule/capsule.js';
import type { ApiContext, ServerContext } from './context.js';
import {
  dashboardSafeError,
  handleDashboard,
  notifyDashboardChanged,
} from './dashboard/dashboard.js';
import { healthResponse } from './health/health.js';
import { runPreflight } from '../platform/preflight.js';
import { send, sendJson } from './respond.js';
import { resolveAppVersion } from '../platform/version.js';
import { type DiscordWebhookContext, discordWebhookResponse } from './webhooks/discord.js';
import { type GitHubWebhookContext, githubWebhookResponse } from './webhooks/github.js';
import { type LinearWebhookContext, linearWebhookResponse } from './webhooks/linear.js';

export type { ApiContext } from './context.js';

const log = logger.child('http');

export function createApiServer(context: ApiContext): Server {
  const serverContext: ServerContext = {
    ...context,
    appVersion: context.appVersion ?? resolveAppVersion(context.env ?? process.env),
  };
  return createServer(async (request, response) => {
    const startedAtMs = nowMs();
    const method = request.method ?? 'GET';
    const path = (request.url ?? '/').split('?')[0];
    let handlerError: string | undefined;
    try {
      await routeRequest(serverContext, request, response);
    } catch (error) {
      handlerError = dashboardSafeError(error);
      sendJson(response, 500, { error: handlerError });
    } finally {
      // Single consolidated line per request so a thrown handler does not emit a
      // duplicate error entry; the error message rides along on the 5xx line.
      logRequest(method, path, response.statusCode, nowMs() - startedAtMs, handlerError);
    }
  });
}

function logRequest(
  method: string,
  path: string,
  status: number,
  durationMs: number,
  error?: string,
): void {
  const fields = { method, path, status, duration_ms: durationMs, error };
  if (status >= 500) {
    log.error('request', fields);
  } else if (status >= 400) {
    log.warn('request', fields);
  } else if (path === '/health') {
    // Health probes are frequent; keep them at debug so the default view stays readable.
    log.debug('request', fields);
  } else {
    log.info('request', fields);
  }
}

async function routeRequest(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const method = request.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/') {
    send(response, { status: 302, headers: { location: '/dashboard' } });
    return;
  }

  if (method === 'GET' && url.pathname === '/health') {
    send(response, healthResponse(context));
    return;
  }

  // Unauthenticated on purpose, like /health: the one thing it answers is what this
  // deployment is still missing, and the admin token is usually part of that.
  if (method === 'GET' && url.pathname === '/setup') {
    send(response, {
      status: 200,
      body: await runPreflight(context.config, context.env ?? process.env),
    });
    return;
  }

  if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) {
    await handleDashboard(context, request, response, url);
    return;
  }

  if (url.pathname.startsWith('/admin/')) {
    if (!requireAdmin(context, request, response)) return;
    await handleAdmin(context, request, response, url);
    return;
  }

  if (url.pathname.startsWith('/capsule/')) {
    if (!requireAdmin(context, request, response)) return;
    send(
      response,
      capsuleResponse(context, {
        method,
        url,
        rawBody: (await readRawBody(request)).toString('utf8'),
      }),
    );
    return;
  }

  if (method === 'POST' && url.pathname === '/webhooks/github') {
    send(
      response,
      await githubWebhookResponse(githubWebhookContext(context), {
        body: await readRawBody(request),
        headers: request.headers,
      }),
    );
    return;
  }

  if (method === 'POST' && url.pathname === '/webhooks/linear') {
    send(
      response,
      await linearWebhookResponse(linearWebhookContext(context), {
        body: await readRawBody(request),
        headers: request.headers,
      }),
    );
    return;
  }

  if (method === 'POST' && url.pathname === '/webhooks/discord') {
    send(
      response,
      await discordWebhookResponse(discordWebhookContext(context), {
        body: await readRawBody(request),
        headers: request.headers,
      }),
    );
    return;
  }

  sendJson(response, 404, { error: 'not_found' });
}

async function handleAdmin(
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const method = request.method ?? 'GET';
  const handled = await adminResponse(adminContext(context), { method, url });
  if (handled) {
    send(response, handled);
    return;
  }

  sendJson(response, 404, { error: 'admin_route_not_found' });
}

function adminContext(context: ApiContext) {
  return {
    ...context,
    announceLogReview: context.commands.announceLogReview,
    notifyChanged: () => notifyDashboardChanged(context),
  };
}

// A receiver gets the single command it hands its deliveries to, so an event that
// reaches another machine changes that command and not this surface.
function githubWebhookContext(context: ApiContext): GitHubWebhookContext {
  return {
    ...context,
    deliver: context.commands.deliverGitHubWebhook,
    notifyChanged: () => notifyDashboardChanged(context),
  };
}

function discordWebhookContext(context: ApiContext): DiscordWebhookContext {
  return {
    ...context,
    deliver: context.commands.deliverDiscordCommand,
    notifyChanged: () => notifyDashboardChanged(context),
  };
}

function linearWebhookContext(context: ApiContext): LinearWebhookContext {
  return {
    ...context,
    deliver: context.commands.deliverLinearWebhook,
    notifyChanged: () => notifyDashboardChanged(context),
  };
}
