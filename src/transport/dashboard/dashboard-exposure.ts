import { hostname } from 'node:os';

import type { Store } from '../../store/store.js';
import type { AppConfig } from '../../config.js';
import { logger } from '../../platform/logger.js';

const log = logger.child('dashboard-expose');

export interface DashboardExposureOptions {
  enabled: boolean;
  sessionId: string;
  port: number;
  slug?: string;
  ttlMs?: number;
}

export interface ExposedDashboardPort {
  port: number;
  previewUrl: string;
  expiresAt?: Date;
  previewUrlId?: string;
  slug?: string;
}

interface DashboardExposureSession {
  exposePort(
    port: number,
    options?: { slug?: string; ttlMs?: number },
  ): Promise<ExposedDashboardPort>;
}

interface DashboardExposureClient {
  get(sessionId: string): Promise<DashboardExposureSession>;
}

export function dashboardExposureOptions(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
  sessionHostname = hostname(),
): DashboardExposureOptions {
  const enabled = dashboardExposureEnabled(env, sessionHostname);
  const sessionId = (env.DASHBOARD_EXPOSE_SESSION_ID || sessionHostname).trim();
  const slug = optionalEnv(env.DASHBOARD_EXPOSE_SLUG);
  const ttlMs = ttlMinutesToMs(env.DASHBOARD_EXPOSE_TTL_MINUTES);
  return {
    enabled,
    sessionId,
    port: config.server.port,
    ...(slug ? { slug } : {}),
    ...(ttlMs ? { ttlMs } : {}),
  };
}

export async function exposeDashboardOnStartup(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
  store?: Pick<Store, 'appendEvent'>,
): Promise<ExposedDashboardPort | undefined> {
  const options = dashboardExposureOptions(config, env);
  if (!options.enabled) return undefined;

  try {
    const { TenkiSandbox } = await import('@tenkicloud/sandbox');
    return await exposeDashboardPort(
      options,
      new TenkiSandbox(tenkiSandboxOptions(config, env)),
      store,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store?.appendEvent({
      eventType: 'orchestrator.dashboard_exposure_failed',
      metadata: {
        session_id: options.sessionId,
        port: options.port,
        error: message,
      },
    });
    log.error('dashboard port exposure failed', {
      session_id: options.sessionId,
      port: options.port,
      error: message,
    });
    return undefined;
  }
}

export async function exposeDashboardPort(
  options: DashboardExposureOptions,
  client: DashboardExposureClient,
  store?: Pick<Store, 'appendEvent'>,
): Promise<ExposedDashboardPort | undefined> {
  if (!options.enabled) return undefined;
  const session = await client.get(options.sessionId);
  const exposed = await session.exposePort(options.port, {
    ...(options.slug ? { slug: options.slug } : {}),
    ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
  });
  store?.appendEvent({
    eventType: 'orchestrator.dashboard_exposed',
    metadata: {
      session_id: options.sessionId,
      port: exposed.port,
      preview_url: exposed.previewUrl,
      preview_url_id: exposed.previewUrlId,
      slug: exposed.slug,
      expires_at: exposed.expiresAt?.toISOString(),
    },
  });
  log.info('dashboard exposed', {
    session_id: options.sessionId,
    port: exposed.port,
    preview_url: exposed.previewUrl,
    slug: exposed.slug,
  });
  return exposed;
}

function tenkiSandboxOptions(config: AppConfig, env: NodeJS.ProcessEnv): Record<string, string> {
  const apiKey = env[config.worker.tenkiApiKeyEnv];
  const options: Record<string, string> = {};
  if (apiKey) options.authToken = apiKey;
  if (env[config.worker.tenkiApiUrlEnv]) options.baseUrl = env[config.worker.tenkiApiUrlEnv]!;
  return options;
}

function dashboardExposureEnabled(env: NodeJS.ProcessEnv, sessionHostname: string): boolean {
  const explicit = envFlag(env.DASHBOARD_EXPOSE_ON_STARTUP);
  if (explicit !== undefined) return explicit;

  const templateKind = env.JARDINERO_TEMPLATE_KIND?.trim().toLowerCase();
  if (templateKind === 'orchestrator') return true;
  if (templateKind === 'worker') return false;

  return looksLikeUuid(sessionHostname);
}

function envFlag(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return undefined;
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function ttlMinutesToMs(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const minutes = Number(trimmed);
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  return Math.round(minutes * 60_000);
}
