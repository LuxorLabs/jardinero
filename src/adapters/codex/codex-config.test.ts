import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type AppConfig, loadConfig } from '../../config.js';
import { buildCodexConfigToml } from './codex-config.js';

const GRAFANA_URL = 'https://mcp-grafana.example.test/mcp';

describe('buildCodexConfigToml', () => {
  const cases = [
    {
      name: 'When grafana mcp is disabled then should return an empty config',
      grafana: { enabled: false },
      want: '',
    },
    {
      name: 'When grafana mcp uses oauth then should emit a plain remote server',
      grafana: { auth: 'oauth' as const },
      want: `[mcp_servers.grafana]\nurl = "${GRAFANA_URL}"\n`,
    },
    {
      name: 'When grafana mcp needs no auth then should emit a plain remote server',
      grafana: { auth: 'none' as const },
      want: `[mcp_servers.grafana]\nurl = "${GRAFANA_URL}"\n`,
    },
    {
      name: 'When grafana mcp uses a service account then should emit the token env var',
      grafana: { auth: 'service_account' as const, serviceAccountTokenEnv: 'GRAFANA_SA_TOKEN' },
      want: `[mcp_servers.grafana]\nurl = "${GRAFANA_URL}"\nbearer_token_env_var = "GRAFANA_SA_TOKEN"\n`,
    },
    {
      name: 'When the server name is not a bare key then should quote it',
      grafana: { name: 'grafana.staging', auth: 'oauth' as const },
      want: `[mcp_servers."grafana.staging"]\nurl = "${GRAFANA_URL}"\n`,
    },
    {
      name: 'When the server name contains a quote then should escape it',
      grafana: { name: 'graf"ana', auth: 'oauth' as const },
      want: `[mcp_servers."graf\\"ana"]\nurl = "${GRAFANA_URL}"\n`,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(buildCodexConfigToml(configWith(c.grafana)), c.want);
    });
  }
});

// Every grafana field the builder reads is set here, so the bundled config only
// supplies the unrelated branches of the tree.
function configWith(grafana: Partial<AppConfig['mcp']['grafana']>): AppConfig {
  const config = loadConfig();
  config.mcp.grafana = {
    ...config.mcp.grafana,
    enabled: true,
    name: 'grafana',
    url: GRAFANA_URL,
    auth: 'service_account',
    serviceAccountTokenEnv: 'GRAFANA_SA_TOKEN',
    ...grafana,
  };
  return config;
}
