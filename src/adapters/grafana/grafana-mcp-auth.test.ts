import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadConfig } from '../../config.js';
import { buildGrafanaMcpCredentialsJson } from './grafana-mcp-auth.js';

const GRAFANA_URL = 'https://grafana.example.test/mcp';

describe('buildGrafanaMcpCredentialsJson', () => {
  test('When the access token is a jwt then should take its expiry', () => {
    const accessToken = jwtWithExpiry(123);

    const result = buildGrafanaMcpCredentialsJson(oauthConfig(), {
      GRAFANA_CLIENT_ID: 'client-id',
      GRAFANA_ACCESS_TOKEN: accessToken,
      GRAFANA_REFRESH_TOKEN: 'refresh-token',
    });

    assert.deepEqual(result.missingEnv, []);
    const parsed = JSON.parse(result.contents!) as Record<string, Record<string, unknown>>;
    assert.deepEqual(parsed.grafana, {
      server_name: 'grafana',
      server_url: GRAFANA_URL,
      client_id: 'client-id',
      access_token: accessToken,
      refresh_token: 'refresh-token',
      expires_at: 123000,
      scopes: [],
    });
  });

  test('When the access token is opaque then should give it a sandbox lifetime expiry', () => {
    const before = Date.now();

    const result = buildGrafanaMcpCredentialsJson(oauthConfig(), {
      GRAFANA_CLIENT_ID: 'client-id',
      GRAFANA_ACCESS_TOKEN: 'opaque-token',
      GRAFANA_REFRESH_TOKEN: 'refresh-token',
    });

    const after = Date.now();
    const parsed = JSON.parse(result.contents!) as Record<string, Record<string, unknown>>;
    assert.equal(typeof parsed.grafana.expires_at, 'number');
    assert.ok(Number(parsed.grafana.expires_at) >= before + 3_600_000);
    assert.ok(Number(parsed.grafana.expires_at) <= after + 3_600_000);
  });

  // Credentials are written only when the whole set is present; a partial write
  // would hand the agent a token it cannot refresh.
  const missingEnvCases: Array<{ name: string; env: NodeJS.ProcessEnv; wantMissing: string[] }> = [
    {
      name: 'When some env vars are missing then should report them and write nothing',
      env: { GRAFANA_CLIENT_ID: 'client-id' },
      wantMissing: ['GRAFANA_ACCESS_TOKEN', 'GRAFANA_REFRESH_TOKEN'],
    },
    {
      name: 'When every env var is missing then should report all of them',
      env: {},
      wantMissing: ['GRAFANA_CLIENT_ID', 'GRAFANA_ACCESS_TOKEN', 'GRAFANA_REFRESH_TOKEN'],
    },
  ];

  for (const testCase of missingEnvCases) {
    test(testCase.name, () => {
      const result = buildGrafanaMcpCredentialsJson(oauthConfig(), testCase.env);

      assert.equal(result.contents, undefined);
      assert.deepEqual(result.missingEnv, testCase.wantMissing);
    });
  }
});

function oauthConfig() {
  const config = loadConfig();
  config.mcp.grafana.auth = 'oauth';
  config.mcp.grafana.url = GRAFANA_URL;
  return config;
}

function jwtWithExpiry(exp: number): string {
  return ['header', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 'signature'].join(
    '.',
  );
}
