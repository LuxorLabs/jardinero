import type { AppConfig } from '../config.js';
import { grafanaMcpRequiredEnvNames } from '../adapters/grafana/grafana-mcp-auth.js';
import { hostCodexAuthExists } from '../adapters/codex/codex-auth.js';

export type PreflightStatus = 'ok' | 'warning' | 'error';

export interface PreflightCheck {
  name: string;
  status: PreflightStatus;
  detail: string;
}

export interface PreflightReport {
  status: PreflightStatus;
  checks: PreflightCheck[];
}

// Served unauthenticated on /setup, so a detail says whether something is configured
// and not what it is: no hostnames, no filesystem paths, no credential values.
export async function runPreflight(config: AppConfig, env = process.env): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];

  checks.push({
    name: 'worker_runner',
    status: 'ok',
    detail: `worker.runner=${config.worker.runner}`,
  });

  checks.push(
    envCheck(env, config.auth.adminTokenEnv, 'admin_auth', 'Admin API bearer token is configured.'),
  );

  // Every workflow ends in a pull request, so the App is not optional for any of them.
  checks.push(
    envCheck(env, config.githubApp.appIdEnv, 'github_app_id', 'GitHub App id is configured.'),
  );
  checks.push(
    envCheck(
      env,
      config.githubApp.installIdEnv,
      'github_app_installation',
      'GitHub App installation id is configured.',
    ),
  );
  checks.push(githubPrivateKeyCheck(config, env));
  checks.push(
    envCheck(
      env,
      config.githubApp.webhookSecretEnv,
      'github_webhook_secret',
      'GitHub webhook deliveries are verified against a shared secret.',
    ),
  );

  checks.push(gitAuthorCheck(config));
  checks.push(agentLoginCheck(config));

  // One warning per env var a repo declares as its own secret.
  for (const [repo, target] of Object.entries(config.worker.repos)) {
    for (const envName of target.secretEnvs ?? []) {
      checks.push(
        envCheck(
          env,
          envName,
          `worker_secret_${envName.toLowerCase()}`,
          `${envName} is configured for ${repo}.`,
          'warning',
        ),
      );
    }
  }

  if (config.workflows.linearImplementer.enabled) {
    const linear = config.workflows.linearImplementer;
    checks.push(
      envCheck(
        env,
        linear.clientIdEnv,
        'linear_client_id',
        'Linear OAuth client id is configured.',
      ),
    );
    checks.push(
      envCheck(
        env,
        linear.clientSecretEnv,
        'linear_client_secret',
        'Linear OAuth client secret is configured. The app needs the client_credentials grant, which Linear enables on request.',
      ),
    );
    checks.push(
      envCheck(
        env,
        linear.webhookSecretEnv,
        'linear_webhook_secret',
        'Linear webhook deliveries are verified against a shared secret.',
      ),
    );
  }

  if (config.discord.enabled) {
    checks.push(
      envCheck(
        env,
        config.discord.applicationIdEnv,
        'discord_application',
        'Discord application id is configured.',
      ),
    );
    checks.push(
      envCheck(
        env,
        config.discord.publicKeyEnv,
        'discord_public_key',
        'Discord interaction signatures are verified against the application key.',
      ),
    );
    checks.push(
      envCheck(env, config.discord.botTokenEnv, 'discord_bot_token', 'Discord bot token is set.'),
    );
    checks.push(discordChannelCheck(config));
  }

  if (config.workflows.logReviewer.enabled && config.mcp.grafana.enabled) {
    checks.push({
      name: 'grafana_mcp',
      status: config.mcp.grafana.url ? 'ok' : 'warning',
      detail: config.mcp.grafana.url
        ? `Grafana MCP is configured, using ${config.mcp.grafana.auth}.`
        : 'Grafana MCP URL is not configured.',
    });
  }

  if (config.worker.runner === 'tenki') {
    checks.push(await tenkiSdkCheck());
    checks.push(tenkiAuthCheck(config, env));
  } else if (config.worker.runner === 'freestyle') {
    checks.push(await freestyleSdkCheck());
    checks.push(
      envCheck(
        env,
        config.worker.freestyleApiKeyEnv,
        'freestyle_auth',
        `${config.worker.freestyleApiKeyEnv} is configured.`,
      ),
    );
  }

  if (config.worker.runner !== 'mock') {
    checks.push(codexAuthCheck(config, env));
    if (config.workflows.logReviewer.enabled && config.mcp.grafana.enabled) {
      for (const envName of grafanaMcpRequiredEnvNames(config)) {
        checks.push(
          envCheck(
            env,
            envName,
            `grafana_mcp_${envName.toLowerCase()}`,
            `${envName} is configured.`,
          ),
        );
      }
    }
  }

  return {
    status: summarize(checks),
    checks,
  };
}

// Presence is not enough for this one: pasting the App id, or a path to the file
// instead of its contents, is the common mistake and it reads as configured.
function githubPrivateKeyCheck(config: AppConfig, env: NodeJS.ProcessEnv): PreflightCheck {
  const key = env[config.githubApp.privateKeyEnv];
  if (!key) {
    return {
      name: 'github_app_key',
      status: 'error',
      detail: `Missing ${config.githubApp.privateKeyEnv}.`,
    };
  }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) {
    return {
      name: 'github_app_key',
      status: 'error',
      detail: `${config.githubApp.privateKeyEnv} does not carry a PEM private key. It holds the key's contents, not a path to it.`,
    };
  }
  return {
    name: 'github_app_key',
    status: 'ok',
    detail: 'GitHub App private key is a PEM.',
  };
}

function discordChannelCheck(config: AppConfig): PreflightCheck {
  if (config.discord.defaultChannelId.trim()) {
    return {
      name: 'discord_channels',
      status: 'ok',
      detail: 'Announcements without a channel of their own fall back to the default one.',
    };
  }
  const mapped = Object.keys(config.discord.repoChannels).length;
  return {
    name: 'discord_channels',
    status: 'warning',
    detail: `No discord.default_channel_id; work in any repository outside the ${mapped} mapped in discord.repo_channels is announced nowhere.`,
  };
}

function gitAuthorCheck(config: AppConfig): PreflightCheck {
  const name = config.worker.gitAuthorName.trim();
  const email = config.worker.gitAuthorEmail.trim();
  if (name && email) {
    return {
      name: 'git_author',
      status: 'ok',
      detail: `Agent commits will be attributed to ${name} <${email}>.`,
    };
  }
  return {
    name: 'git_author',
    status: 'warning',
    detail:
      'worker.git_author_name and worker.git_author_email are not both set; agent commits will use the sandbox default identity and may not link to your GitHub account.',
  };
}

// .env.example ships these, so a value still equal to one is published, not secret.
const ENV_PLACEHOLDERS = new Set(['replace_me', 'replace-with-random-token']);

function agentLoginCheck(config: AppConfig): PreflightCheck {
  if (!config.workflows.prMaintainer.enabled) {
    return {
      name: 'agent_login',
      status: 'ok',
      detail: 'The pull request maintainer is off.',
    };
  }
  if (!config.workflows.prMaintainer.agentLogin) {
    return {
      name: 'agent_login',
      status: 'error',
      detail:
        'workflows.pr_maintainer.agent_login is not set, so a mention on a pull request reaches Jardinero and is ignored.',
    };
  }
  return {
    name: 'agent_login',
    status: 'ok',
    detail: 'A mention of the configured handle starts a maintenance pass.',
  };
}

function envCheck(
  env: NodeJS.ProcessEnv,
  name: string,
  checkName: string,
  successDetail: string,
  missingStatus: PreflightStatus = 'error',
): PreflightCheck {
  const value = env[name];
  if (value && !ENV_PLACEHOLDERS.has(value)) {
    return { name: checkName, status: 'ok', detail: successDetail };
  }
  return {
    name: checkName,
    status: missingStatus,
    detail: value ? `${name} is still the .env.example placeholder.` : `Missing ${name}.`,
  };
}

async function tenkiSdkCheck(): Promise<PreflightCheck> {
  try {
    await import('@tenkicloud/sandbox');
    return {
      name: 'tenki_sdk',
      status: 'ok',
      detail: '@tenkicloud/sandbox is installed and importable.',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: 'tenki_sdk',
      status: 'error',
      detail: `Cannot import @tenkicloud/sandbox: ${message}`,
    };
  }
}

async function freestyleSdkCheck(): Promise<PreflightCheck> {
  try {
    await import('freestyle');
    return {
      name: 'freestyle_sdk',
      status: 'ok',
      detail: 'freestyle is installed and importable.',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: 'freestyle_sdk',
      status: 'error',
      detail: `Cannot import freestyle: ${message}`,
    };
  }
}

function tenkiAuthCheck(config: AppConfig, env: NodeJS.ProcessEnv): PreflightCheck {
  if (env[config.worker.tenkiApiKeyEnv]) {
    return {
      name: 'tenki_auth',
      status: 'ok',
      detail: `${config.worker.tenkiApiKeyEnv} is configured.`,
    };
  }
  return {
    name: 'tenki_auth',
    status: 'warning',
    detail: `No ${config.worker.tenkiApiKeyEnv}; SDK must rely on ambient Capsule auth.`,
  };
}

function codexAuthCheck(config: AppConfig, env: NodeJS.ProcessEnv): PreflightCheck {
  if (config.worker.codexAuthMode === 'capsule') {
    if (hostCodexAuthExists()) {
      return {
        name: 'codex_auth',
        status: 'ok',
        detail: "Forwarding the host's Codex auth into worker sandboxes.",
      };
    }
    return {
      name: 'codex_auth',
      status: 'error',
      detail:
        'No ~/.codex/auth.json for capsule Codex auth mode. Run "codex login" on the orchestrator host first.',
    };
  }

  if (config.worker.codexAuthMode === 'access_token') {
    if (env[config.worker.codexAccessTokenEnv]) {
      return {
        name: 'codex_auth',
        status: 'ok',
        detail: `Using Codex access token from ${config.worker.codexAccessTokenEnv}.`,
      };
    }
    return {
      name: 'codex_auth',
      status: 'error',
      detail: `Missing ${config.worker.codexAccessTokenEnv} for access_token Codex auth mode.`,
    };
  }

  if (env[config.worker.codexApiKeyEnv]) {
    return {
      name: 'codex_auth',
      status: 'ok',
      detail: `Using OpenAI API key from ${config.worker.codexApiKeyEnv}.`,
    };
  }
  return {
    name: 'codex_auth',
    status: 'error',
    detail: `Missing ${config.worker.codexApiKeyEnv} for api_key Codex auth mode.`,
  };
}

function summarize(checks: PreflightCheck[]): PreflightStatus {
  if (checks.some((check) => check.status === 'error')) return 'error';
  if (checks.some((check) => check.status === 'warning')) return 'warning';
  return 'ok';
}
