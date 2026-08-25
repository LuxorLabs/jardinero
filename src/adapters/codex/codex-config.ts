import type { AppConfig } from '../../config.js';

export function buildCodexConfigToml(config: AppConfig): string {
  const lines: string[] = [];

  if (config.mcp.grafana.enabled) {
    lines.push(`[mcp_servers.${tomlBareKey(config.mcp.grafana.name)}]`);
    lines.push(`url = ${tomlString(config.mcp.grafana.url)}`);
    if (config.mcp.grafana.auth === 'service_account') {
      lines.push(`bearer_token_env_var = ${tomlString(config.mcp.grafana.serviceAccountTokenEnv)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function tomlBareKey(value: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
  return tomlString(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
