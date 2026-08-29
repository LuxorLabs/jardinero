import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AppConfig } from '../config.js';
import { loadConfig } from '../config.js';
import { runPreflight } from './preflight.js';

// A case that asserts what happens without one of these sets it back to undefined.
const GITHUB_ENV = {
  JARDINERO_AGENT_APP_ID: 'app-1',
  JARDINERO_AGENT_INSTALL_ID: 'install-1',
  JARDINERO_AGENT_PRIVATE_KEY:
    '-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----',
  JARDINERO_AGENT_WEBHOOK_SECRET: 'whsecret',
};

describe('runPreflight', () => {
  // Every row pins one check's verdict for a config and env. The report's status is
  // the worst verdict in it, so a row also pins how that verdict is summarized.
  const cases: Array<{
    name: string;
    configure?(config: AppConfig): void;
    env: Record<string, string | undefined>;
    wantChecks: Record<string, 'ok' | 'warning' | 'error'>;
    wantStatus?: 'ok' | 'warning' | 'error';
    wantAbsent?: string[];
  }> = [
    {
      name: 'When the runner is mock then should report it without any tenki check',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.workflows.prMaintainer.agentLogin = 'acme-jardinero';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin' },
      wantChecks: { worker_runner: 'ok', admin_auth: 'ok', grafana_mcp: 'ok' },
      wantStatus: 'ok',
      wantAbsent: ['tenki_sdk', 'tenki_auth', 'tenki_workspace', 'codex_auth'],
    },
    {
      name: 'When the admin token is missing then should return error',
      configure: (config) => {
        config.worker.runner = 'mock';
      },
      env: {},
      wantChecks: { admin_auth: 'error' },
      wantStatus: 'error',
    },
    {
      name: 'When a repo secret env is missing then should only warn',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.worker.repos['acme/alpha'] = { secretEnvs: ['ALPHA_KEY'] };
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin' },
      wantChecks: { worker_secret_alpha_key: 'warning' },
    },
    {
      name: 'When a repo secret env is set then should report it configured',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.worker.repos['acme/alpha'] = { secretEnvs: ['ALPHA_KEY'] };
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin', ALPHA_KEY: 'value' },
      wantChecks: { worker_secret_alpha_key: 'ok' },
    },
    {
      name: 'When no repo declares a secret env then should report no secret check',
      configure: (config) => {
        config.worker.runner = 'mock';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin' },
      wantChecks: { admin_auth: 'ok' },
      wantAbsent: ['worker_secret_alpha_key'],
    },
    {
      name: 'When the git author is configured then should attribute commits to it',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.worker.gitAuthorName = 'Jardinero Agent';
        config.worker.gitAuthorEmail = 'agent@example.test';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin' },
      wantChecks: { git_author: 'ok' },
    },
    {
      // Without both halves the sandbox default identity is used and the commits
      // stop linking to a GitHub account.
      name: 'When the git author email is missing then should warn',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.worker.gitAuthorName = 'Jardinero Agent';
        config.worker.gitAuthorEmail = '   ';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin' },
      wantChecks: { git_author: 'warning' },
    },
    {
      name: 'When the grafana url is not configured then should warn',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.mcp.grafana.url = '';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin' },
      wantChecks: { grafana_mcp: 'warning' },
    },
    {
      name: 'When log review is disabled then should not check grafana at all',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.workflows.logReviewer.enabled = false;
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin' },
      wantChecks: { worker_runner: 'ok' },
      wantAbsent: ['grafana_mcp'],
    },
    {
      // The SDK is a real dependency of this repo, so the import succeeds; the
      // failure arm only fires on a broken install.
      name: 'When the runner is tenki then should find the sdk installed',
      configure: (config) => {
        config.worker.runner = 'tenki';
        config.worker.codexAuthMode = 'access_token';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin', TENKI_API_KEY: 'tenki', CODEX_ACCESS_TOKEN: 'x' },
      wantChecks: { tenki_sdk: 'ok', tenki_auth: 'ok' },
    },
    {
      // Both tenki credentials warn rather than error: the SDK can still fall back
      // to ambient Capsule auth, and to a single-project auth.
      name: 'When the tenki key and project are missing then should warn on both',
      configure: (config) => {
        config.worker.runner = 'tenki';
        config.worker.codexAuthMode = 'access_token';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin', CODEX_ACCESS_TOKEN: 'x' },
      wantChecks: { tenki_auth: 'warning', tenki_workspace: 'ok' },
    },
    {
      name: 'When the tenki workspace is configured then should report it',
      configure: (config) => {
        config.worker.runner = 'tenki';
        config.worker.codexAuthMode = 'access_token';
      },
      env: {
        ORCHESTRATOR_ADMIN_TOKEN: 'admin',
        TENKI_API_KEY: 'tenki',
        TENKI_WORKSPACE_ID: 'workspace-1',
        CODEX_ACCESS_TOKEN: 'x',
      },
      wantChecks: { tenki_workspace: 'ok' },
    },
    {
      // Nothing warns when every credential is present, and that is the only path
      // to an 'ok' report.
      name: 'When every credential is configured then should report ok',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.workflows.prMaintainer.agentLogin = 'acme-jardinero';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin' },
      wantChecks: { admin_auth: 'ok', git_author: 'ok' },
      wantStatus: 'ok',
    },
    {
      name: 'When codex auth needs an access token and it is missing then should return error',
      configure: (config) => {
        config.worker.runner = 'tenki';
        config.worker.codexAuthMode = 'access_token';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin', TENKI_API_KEY: 'tenki' },
      wantChecks: { codex_auth: 'error' },
    },
    {
      name: 'When codex auth is api key and the provider key is set then should report it',
      configure: (config) => {
        config.worker.runner = 'tenki';
        config.worker.codexAuthMode = 'api_key';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin', TENKI_API_KEY: 'tenki', OPENAI_API_KEY: 'sk-x' },
      wantChecks: { codex_auth: 'ok' },
    },
    {
      name: 'When codex auth is api key without a provider key then should return error',
      configure: (config) => {
        config.worker.runner = 'tenki';
        config.worker.codexAuthMode = 'api_key';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin', TENKI_API_KEY: 'tenki' },
      wantChecks: { codex_auth: 'error' },
    },
    {
      name: 'When `log_review` needs a grafana service account then should require its token',
      configure: (config) => {
        config.worker.runner = 'tenki';
        config.worker.codexAuthMode = 'access_token';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin', TENKI_API_KEY: 'tenki', CODEX_ACCESS_TOKEN: 'x' },
      wantChecks: { grafana_mcp_grafana_sa_token: 'error' },
      wantStatus: 'error',
    },
    {
      name: 'When grafana uses oauth then should require every oauth env var',
      configure: (config) => {
        config.worker.runner = 'tenki';
        config.worker.codexAuthMode = 'access_token';
        config.mcp.grafana.auth = 'oauth';
      },
      env: {
        ORCHESTRATOR_ADMIN_TOKEN: 'admin',
        TENKI_API_KEY: 'tenki',
        CODEX_ACCESS_TOKEN: 'x',
        GRAFANA_CLIENT_ID: 'client',
      },
      wantChecks: {
        grafana_mcp_grafana_client_id: 'ok',
        grafana_mcp_grafana_access_token: 'error',
        grafana_mcp_grafana_refresh_token: 'error',
      },
      wantStatus: 'error',
    },
    {
      name: 'When the GitHub App id is missing then should return error',
      configure: (config) => {
        config.worker.runner = 'mock';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin', JARDINERO_AGENT_APP_ID: undefined },
      wantChecks: { github_app_id: 'error' },
      wantStatus: 'error',
    },
    {
      name: 'When the installation id is missing then should return error',
      configure: (config) => {
        config.worker.runner = 'mock';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin', JARDINERO_AGENT_INSTALL_ID: undefined },
      wantChecks: { github_app_installation: 'error' },
    },
    {
      name: 'When the pull request maintainer is on and `agent_login` is unset then should return error',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.workflows.prMaintainer.enabled = true;
        config.workflows.prMaintainer.agentLogin = '';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin' },
      wantChecks: { agent_login: 'error' },
      wantStatus: 'error',
    },
    {
      name: 'When the pull request maintainer is on and `agent_login` is set then should report the handle',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.workflows.prMaintainer.enabled = true;
        config.workflows.prMaintainer.agentLogin = 'acme-jardinero';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin' },
      wantChecks: { agent_login: 'ok' },
    },
    {
      name: 'When the pull request maintainer is off then should not ask for `agent_login`',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.workflows.prMaintainer.enabled = false;
        config.workflows.prMaintainer.agentLogin = '';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin' },
      wantChecks: { agent_login: 'ok' },
    },
    {
      name: 'When the admin token is still the `replace-with-random-token` placeholder then should return error',
      configure: (config) => {
        config.worker.runner = 'mock';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'replace-with-random-token' },
      wantChecks: { admin_auth: 'error' },
      wantStatus: 'error',
    },
    {
      name: 'When the webhook secret is still the `replace_me` placeholder then should return error',
      configure: (config) => {
        config.worker.runner = 'mock';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin', JARDINERO_AGENT_WEBHOOK_SECRET: 'replace_me' },
      wantChecks: { github_webhook_secret: 'error' },
      wantStatus: 'error',
    },
    {
      name: 'When the webhook secret is missing then should return error',
      configure: (config) => {
        config.worker.runner = 'mock';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin', JARDINERO_AGENT_WEBHOOK_SECRET: undefined },
      wantChecks: { github_webhook_secret: 'error' },
    },
    {
      name: 'When the private key is missing then should return error',
      configure: (config) => {
        config.worker.runner = 'mock';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin', JARDINERO_AGENT_PRIVATE_KEY: undefined },
      wantChecks: { github_app_key: 'error' },
    },
    {
      name: 'When the private key is not a PEM then should return error',
      configure: (config) => {
        config.worker.runner = 'mock';
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin', JARDINERO_AGENT_PRIVATE_KEY: '/etc/keys/app.pem' },
      wantChecks: { github_app_key: 'error' },
    },
    {
      name: 'When the linear workflow is off then should not ask for its credentials',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.workflows.linearImplementer.enabled = false;
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin' },
      wantChecks: { admin_auth: 'ok' },
      wantAbsent: ['linear_client_id', 'linear_client_secret', 'linear_webhook_secret'],
    },
    {
      name: 'When the linear workflow is on and unconfigured then should return error on each',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.workflows.linearImplementer.enabled = true;
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin' },
      wantChecks: {
        linear_client_id: 'error',
        linear_client_secret: 'error',
        linear_webhook_secret: 'error',
      },
      wantStatus: 'error',
    },
    {
      name: 'When the linear credentials are set then should report them configured',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.workflows.linearImplementer.enabled = true;
      },
      env: {
        ORCHESTRATOR_ADMIN_TOKEN: 'admin',
        LINEAR_CLIENT_ID: 'client',
        LINEAR_CLIENT_SECRET: 'secret',
        LINEAR_WEBHOOK_SECRET: 'linsecret',
      },
      wantChecks: {
        linear_client_id: 'ok',
        linear_client_secret: 'ok',
        linear_webhook_secret: 'ok',
      },
    },
    {
      name: 'When discord is off then should not ask for its credentials',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.discord.enabled = false;
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin' },
      wantChecks: { admin_auth: 'ok' },
      wantAbsent: [
        'discord_application',
        'discord_public_key',
        'discord_bot_token',
        'discord_channels',
      ],
    },
    {
      name: 'When discord is on and unconfigured then should return error on each',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.discord.enabled = true;
      },
      env: { ORCHESTRATOR_ADMIN_TOKEN: 'admin' },
      wantChecks: {
        discord_application: 'error',
        discord_public_key: 'error',
        discord_bot_token: 'error',
      },
      wantStatus: 'error',
    },
    {
      name: 'When discord names a default channel then should report where work lands',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.discord.enabled = true;
        config.discord.defaultChannelId = 'channel-1';
      },
      env: {
        ORCHESTRATOR_ADMIN_TOKEN: 'admin',
        DISCORD_APPLICATION_ID: 'application-1',
        DISCORD_PUBLIC_KEY: 'key',
        DISCORD_BOT_TOKEN: 'bot',
      },
      wantChecks: { discord_channels: 'ok' },
    },
    {
      // The loader refuses discord with no channels at all, so this is the reachable gap.
      name: 'When discord maps channels but names no default then should warn',
      configure: (config) => {
        config.worker.runner = 'mock';
        config.discord.enabled = true;
        config.discord.repoChannels = { 'acme/repo1': 'channel-1' };
        config.discord.defaultChannelId = '';
      },
      env: {
        ORCHESTRATOR_ADMIN_TOKEN: 'admin',
        DISCORD_APPLICATION_ID: 'application-1',
        DISCORD_PUBLIC_KEY: 'key',
        DISCORD_BOT_TOKEN: 'bot',
      },
      wantChecks: { discord_channels: 'warning' },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const config = loadConfig();
      // The bundled config configures nothing, so the checks that answer about
      // configuration start from a configured baseline here; a case that asserts the
      // unconfigured arm overrides it.
      config.workflows.logReviewer.enabled = true;
      config.mcp.grafana.enabled = true;
      config.mcp.grafana.url = 'https://grafana.example.test/mcp';
      config.worker.gitAuthorName = 'Jardinero Agent';
      config.worker.gitAuthorEmail = 'agent@example.test';
      testCase.configure?.(config);

      const report = await runPreflight(config, { ...GITHUB_ENV, ...testCase.env });

      for (const [name, want] of Object.entries(testCase.wantChecks)) {
        assert.equal(report.checks.find((check) => check.name === name)?.status, want, name);
      }
      for (const name of testCase.wantAbsent ?? []) {
        assert.equal(
          report.checks.find((check) => check.name === name),
          undefined,
          `${name} should not be checked`,
        );
      }
      if (testCase.wantStatus) assert.equal(report.status, testCase.wantStatus);
    });
  }
});

describe('what the report is safe to serve', () => {
  // The report is served unauthenticated on /setup, so no detail may echo a value
  // back, whatever the check and whatever the deployment configured.
  test('When every credential is configured then should carry none of them in the report', async () => {
    const config = loadConfig();
    config.worker.runner = 'tenki';
    config.worker.codexAuthMode = 'api_key';
    config.worker.gitAuthorName = 'Jardinero Agent';
    config.worker.gitAuthorEmail = 'agent@example.test';
    config.workflows.logReviewer.enabled = true;
    config.workflows.linearImplementer.enabled = true;
    config.discord.enabled = true;
    config.discord.defaultChannelId = 'channel-secret';
    config.mcp.grafana.enabled = true;
    config.mcp.grafana.url = 'https://grafana.internal.example/mcp';

    const values = {
      ORCHESTRATOR_ADMIN_TOKEN: 'admin-secret',
      TENKI_API_KEY: 'tenki-secret',
      TENKI_WORKSPACE_ID: 'workspace-secret',
      OPENAI_API_KEY: 'sk-secret',
      LINEAR_CLIENT_ID: 'linear-id-secret',
      LINEAR_CLIENT_SECRET: 'linear-secret',
      LINEAR_WEBHOOK_SECRET: 'linear-hook-secret',
      DISCORD_APPLICATION_ID: 'discord-secret',
      DISCORD_PUBLIC_KEY: 'discord-key-secret',
      DISCORD_BOT_TOKEN: 'discord-bot-secret',
      GRAFANA_SA_TOKEN: 'glsa-secret',
    };

    const report = await runPreflight(config, { ...GITHUB_ENV, ...values });

    const details = report.checks.map((check) => check.detail).join('\n');
    for (const value of [...Object.values(values), ...Object.values(GITHUB_ENV)]) {
      assert.ok(!details.includes(value), `report echoed ${value}`);
    }
    assert.ok(!details.includes('grafana.internal.example'), 'report echoed the Grafana host');
    assert.ok(!details.includes('channel-secret'), 'report echoed the Discord channel id');
  });
});
