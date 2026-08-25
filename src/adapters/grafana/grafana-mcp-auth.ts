import type { AppConfig } from '../../config.js';

export interface GrafanaMcpCredentials {
  server_name: string;
  server_url: string;
  client_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scopes: string[];
}

export function grafanaMcpRequiredEnvNames(config: AppConfig): string[] {
  if (config.mcp.grafana.auth === 'service_account') {
    return [config.mcp.grafana.serviceAccountTokenEnv];
  }
  if (config.mcp.grafana.auth === 'oauth') return grafanaMcpOAuthCredentialEnvNames(config);
  return [];
}

export function grafanaMcpOAuthCredentialEnvNames(config: AppConfig): string[] {
  return [
    config.mcp.grafana.clientIdEnv,
    config.mcp.grafana.accessTokenEnv,
    config.mcp.grafana.refreshTokenEnv,
  ];
}

export function buildGrafanaMcpCredentialsJson(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
): { contents?: string; missingEnv: string[] } {
  const missingEnv = grafanaMcpOAuthCredentialEnvNames(config).filter((name) => !env[name]);
  if (missingEnv.length > 0) return { missingEnv };

  const credential: GrafanaMcpCredentials = {
    server_name: config.mcp.grafana.name,
    server_url: config.mcp.grafana.url,
    client_id: env[config.mcp.grafana.clientIdEnv]!,
    access_token: env[config.mcp.grafana.accessTokenEnv]!,
    refresh_token: env[config.mcp.grafana.refreshTokenEnv]!,
    expires_at: jwtExpiresAtMs(env[config.mcp.grafana.accessTokenEnv]!) ?? Date.now() + 3_600_000,
    scopes: [],
  };

  return {
    contents: JSON.stringify({ [config.mcp.grafana.name]: credential }, null, 2),
    missingEnv: [],
  };
}

function jwtExpiresAtMs(token: string): number | undefined {
  const [, payload] = token.split('.');
  if (!payload) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof decoded.exp === 'number' && Number.isFinite(decoded.exp)
      ? decoded.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}
