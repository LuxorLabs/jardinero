import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { type ReactionContent, isReactionContent } from './adapters/github/github-reactions.js';
import type { LogLevel } from './platform/logger.js';
import type {
  FixImplementerState,
  LinearImplementerState,
  LogReviewerState,
  PrMaintainerState,
  RequestRouterState,
  WorkflowType,
} from './store/types.js';

// Codex CLI reasoning-effort levels, passed as `-c model_reasoning_effort=<level>`. The
// scale is Codex-specific: xhigh and max are CLI extensions, not API values.
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];

export interface LinearTeamRepoRoutingConfig {
  default: string;
  projects: Record<string, string>;
  // Repositories this team may select by naming a GitHub reference in the issue,
  // without tying the repository to a Linear project.
  repos: string[];
}

export type LinearTeamRepoConfig = string | LinearTeamRepoRoutingConfig;

// Low-to-high ordering used to clamp effort. Keyed by CodexEffort so the compiler
// forces every level to have a rank.
const EFFORT_RANK: Record<CodexEffort, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
};

// ModelGeneration maps a seat to the model it runs. `implementation` is the base every
// seat inherits, and any seat may override it.
export type ModelGeneration = Record<string, string>;

// WorkerModelRef is the generation and the effort ceiling a repo runs under. The
// generation names a `model_generations` profile.
export interface WorkerModelRef {
  generation: string;
  maxEffort: CodexEffort;
}

// WorkerResources is the sandbox sizing for a seat's runs. Both fields are required
// when set: the block falls back as a unit.
export interface WorkerResources {
  cpuCores: number;
  memoryMb: number;
}

// WorkerTarget is the image and model of the default seat; an unlisted repo runs this.
export interface WorkerTarget {
  image: string;
  model: WorkerModelRef;
  resources?: WorkerResources;
}

// WorkerRepoTarget is a per-repo override; anything omitted inherits `worker.default`.
export interface WorkerRepoTarget {
  image?: string;
  model?: WorkerModelRef;
  resources?: WorkerResources;
  secretEnvs?: string[];
}

export interface AppConfig {
  rootDir: string;
  configPath: string;
  server: {
    host: string;
    port: number;
    publicUrl: string;
  };
  auth: {
    adminTokenEnv: string;
  };
  store: {
    dataPath: string;
    schemaPath: string;
    backupIntervalMin: number;
    backupRetentionCount: number;
  };
  sandboxes: {
    maxConcurrentRuns: number;
    maxWallClockMin: number;
  };
  observability: {
    loki: LokiConfig;
  };
  mcp: {
    grafana: {
      enabled: boolean;
      name: string;
      url: string;
      auth: 'oauth' | 'service_account' | 'none';
      serviceAccountTokenEnv: string;
      accessTokenEnv: string;
      clientIdEnv: string;
      refreshTokenEnv: string;
    };
  };
  workflows: {
    prMaintainer: {
      enabled: boolean;
      maxConcurrentRuns: number;
      maxPushAttempts: number;
      maxRepliesPerThread: number;
      pollIntervalMin: number;
      pollBranchPrefix: string;
      agentLogin: string;
      // Emoji reactions the orchestrator posts on a triggering comment to signal
      // it was seen and later handled, closing the silent gap before the reply.
      commentReactions: {
        enabled: boolean;
        pickup: ReactionContent;
        replied: ReactionContent;
      };
      checkWaitMs: Partial<Record<PrMaintainerState, number>>;
    };
    logReviewer: {
      enabled: boolean;
      repos: LogReviewRepoConfig[];
      scanIntervalMin: number;
      lookbackMin: number;
      maxConcurrentRuns: number;
      investigationConfidenceThreshold: number;
      dryRun: boolean;
      checkWaitMs: Partial<Record<LogReviewerState, number>>;
    };
    fixImplementer: {
      enabled: boolean;
      maxConcurrentRuns: number;
      maxHandoffsPerRun: number;
      maxIterations: number;
      checkWaitMs: Partial<Record<FixImplementerState, number>>;
    };
    requestRouter: {
      enabled: boolean;
      maxConcurrentRuns: number;
      checkWaitMs: Partial<Record<RequestRouterState, number>>;
    };
    linearImplementer: {
      enabled: boolean;
      maxConcurrentRuns: number;
      // Written at runtime with the minted token, not provided as a secret.
      apiTokenEnv: string;
      clientIdEnv: string;
      clientSecretEnv: string;
      tokenRefreshMin: number;
      webhookSecretEnv: string;
      // Linear team key -> repo routing for delegated issues from that team.
      teamRepos: Record<string, LinearTeamRepoConfig>;
      // Implement/verify loop: rejected work is revised on the same branch up to
      // this many iterations; 0 disables verification and PRs open ready.
      maxIterations: number;
      // Reasoning effort for the verifier seat.
      verifyEffort: CodexEffort;
      checkWaitMs: Partial<Record<LinearImplementerState, number>>;
    };
  };
  worker: {
    runner: 'mock' | 'tenki';
    codexAuthMode: 'capsule' | 'access_token' | 'api_key';
    codexAccessTokenEnv: string;
    codexApiKeyEnv: string;
    codexCommand: string;
    codexBypassSandbox: boolean;
    tenkiApiKeyEnv: string;
    tenkiApiUrlEnv: string;
    tenkiProjectIdEnv: string;
    tenkiWorkspaceIdEnv: string;
    githubTokenEnv: string;
    gitAuthorName: string;
    gitAuthorEmail: string;
    default: WorkerTarget;
    repos: Record<string, WorkerRepoTarget>;
    modelGenerations: Record<string, ModelGeneration>;
    workspacePath: string;
    sessionCloseTimeoutMs: number;
    maxSandboxReadyAttempts: number;
    sandboxReadyBackoffBaseMs: number;
    sandboxReadyBackoffJitterMs: number;
    implementationEffort: CodexEffort;
    triageEffort: CodexEffort;
    // Stamped onto every sandbox's metadata so an operator (and a future
    // re-attach path) can tell which orchestrator deployment owns it. Distinct
    // per deployment when several share a Tenki project.
    orchestratorId: string;
    // Backstop for the reaper: Tenki terminates an idle-paused sandbox after this
    // long instead of leaving it paused indefinitely. Bounds the leak for any
    // sandbox the reaper does not reclaim (e.g. its run row was pruned).
    sandboxPauseRetentionMs: number;
    // How often the reaper sweeps the Tenki project for leaked sandboxes; < 1
    // disables it.
    sandboxReaperIntervalMin: number;
  };
  githubApp: {
    appIdEnv: string;
    installIdEnv: string;
    privateKeyEnv: string;
    tokenRefreshMin: number;
    webhookSecretEnv: string;
  };
  discord: {
    enabled: boolean;
    applicationIdEnv: string;
    publicKeyEnv: string;
    botTokenEnv: string;
    // Role ids allowed to run the commands. An empty list admits nobody, because a
    // command spends money and a missing role must fail closed.
    allowedRoleIds: string[];
    // Repository full name -> its channel. Several repositories may share one, so the
    // reverse reading only answers when a channel maps to exactly one repository.
    repoChannels: Record<string, string>;
    // Where work whose repository has no channel is announced.
    defaultChannelId: string;
    // Where an instance parked for a person, and Jardinero's own breakage, is announced.
    alertsChannelId: string;
  };
  people: PersonConfig[];
}

// PersonConfig is one person under the three identities Jardinero meets them by, so an
// event that arrives under one can be answered under another.
export interface PersonConfig {
  discordUserId: string;
  discordUsername: string;
  githubLogin?: string;
  linearUserId?: string;
}

export interface LokiConfig {
  enabled: boolean;
  pushUrl: string;
  authEnv: string;
  labels: Record<string, string>;
  minLevel: LogLevel;
  maxBatchEntries: number;
  flushIntervalMs: number;
  maxBufferEntries: number;
  maxRetryAttempts: number;
  retryInitialMs: number;
  maxRetryMs: number;
  pushTimeoutMs: number;
}

export interface LogReviewRepoConfig {
  repo: string;
  namespace?: string;
  clusters: string[];
  services: string[];
  permissionSignals?: LogReviewPermissionSignalsConfig;
}

export interface LogReviewPermissionSignalsConfig {
  statusCodes: number[];
  grpcCodes: string[];
  keywords: string[];
  knownNoise: string[];
}

type RawConfig = Record<string, unknown>;

// How long a state waits before the periodic check revisits it. Only the states with
// work to revisit appear; one left out is never checked, which is what keeps the clock
// off the states a webhook or a finished run wakes.
const DEFAULT_REQUEST_ROUTER_CHECK_WAIT_MS: Partial<Record<RequestRouterState, number>> = {
  rr_pending: 60_000,
  rr_routing: 120_000,
};

const DEFAULT_LINEAR_IMPLEMENTER_CHECK_WAIT_MS: Partial<Record<LinearImplementerState, number>> = {
  li_pending: 60_000,
  li_implementing: 120_000,
  li_verifying: 120_000,
  li_waiting_pr: 3_600_000,
};

const DEFAULT_FIX_IMPLEMENTER_CHECK_WAIT_MS: Partial<Record<FixImplementerState, number>> = {
  fi_pending: 60_000,
  fi_implementing: 120_000,
  fi_verifying: 60_000,
  fi_waiting_pr: 3_600_000,
};

const DEFAULT_PR_MAINTAINER_CHECK_WAIT_MS: Partial<Record<PrMaintainerState, number>> = {
  prm_pending: 60_000,
  prm_working: 120_000,
  prm_waiting: 300_000,
};

const DEFAULT_LOG_REVIEWER_CHECK_WAIT_MS: Partial<Record<LogReviewerState, number>> = {
  lr_pending: 60_000,
  lr_working: 120_000,
};

// In-repo default for local dev and self-contained instances. A real deployment
// overrides it with CONFIG_PATH pointing at its mounted file.
const DEFAULT_CONFIG_PATH = 'config/local.yaml';

export function loadConfig(
  configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
  rootDir = process.cwd(),
): AppConfig {
  const absolutePath = path.resolve(rootDir, configPath);
  const raw = YAML.parse(readFileSync(absolutePath, 'utf8')) as RawConfig;
  const logReviewRepos = logReviewReposAt(raw);

  const config: AppConfig = {
    rootDir,
    configPath,
    server: {
      host: stringAt(raw, ['server', 'host'], '0.0.0.0'),
      port: numberAt(raw, ['server', 'port'], 3000),
      // Public base URL of this instance; used to build dashboard run links in
      // Linear write-backs. Empty (default) omits the link, e.g. for local dev.
      publicUrl: stringAt(raw, ['server', 'public_url'], ''),
    },
    auth: {
      adminTokenEnv: stringAt(raw, ['auth', 'admin_token_env'], 'ORCHESTRATOR_ADMIN_TOKEN'),
    },
    store: {
      dataPath: resolveFromRoot(rootDir, stringAt(raw, ['store', 'data_path'], './data')),
      schemaPath: resolveFromRoot(
        rootDir,
        stringAt(raw, ['store', 'schema_path'], './db/schema.sql'),
      ),
      backupIntervalMin: numberAt(raw, ['store', 'backup_interval_min'], 60),
      backupRetentionCount: numberAt(raw, ['store', 'backup_retention_count'], 24),
    },
    sandboxes: {
      maxConcurrentRuns: numberAt(raw, ['sandboxes', 'max_concurrent_runs'], 10),
      maxWallClockMin: numberAt(raw, ['sandboxes', 'max_wall_clock_min'], 30),
    },
    observability: {
      loki: lokiConfigAt(raw),
    },
    mcp: {
      grafana: {
        enabled: booleanAt(raw, ['mcp', 'grafana', 'enabled'], false),
        name: stringAt(raw, ['mcp', 'grafana', 'name'], 'grafana'),
        url: stringAt(raw, ['mcp', 'grafana', 'url'], ''),
        auth: mcpAuthAt(raw, ['mcp', 'grafana', 'auth'], 'service_account'),
        serviceAccountTokenEnv: stringAt(
          raw,
          ['mcp', 'grafana', 'service_account_token_env'],
          'GRAFANA_SA_TOKEN',
        ),
        accessTokenEnv: stringAt(
          raw,
          ['mcp', 'grafana', 'access_token_env'],
          'GRAFANA_ACCESS_TOKEN',
        ),
        clientIdEnv: stringAt(raw, ['mcp', 'grafana', 'client_id_env'], 'GRAFANA_CLIENT_ID'),
        refreshTokenEnv: stringAt(
          raw,
          ['mcp', 'grafana', 'refresh_token_env'],
          'GRAFANA_REFRESH_TOKEN',
        ),
      },
    },
    workflows: {
      prMaintainer: {
        enabled: booleanAt(raw, ['workflows', 'pr_maintainer', 'enabled'], true),
        maxConcurrentRuns: numberAt(raw, ['workflows', 'pr_maintainer', 'max_concurrent_runs'], 3),
        maxPushAttempts: numberAt(raw, ['workflows', 'pr_maintainer', 'max_push_attempts'], 15),
        maxRepliesPerThread: numberAt(
          raw,
          ['workflows', 'pr_maintainer', 'max_replies_per_thread'],
          2,
        ),
        pollIntervalMin: numberAt(raw, ['workflows', 'pr_maintainer', 'poll_interval_min'], 5),
        pollBranchPrefix: stringAt(
          raw,
          ['workflows', 'pr_maintainer', 'poll_branch_prefix'],
          'agent/',
        ),
        agentLogin: stringAt(raw, ['workflows', 'pr_maintainer', 'agent_login'], ''),
        commentReactions: {
          enabled: booleanAt(
            raw,
            ['workflows', 'pr_maintainer', 'comment_reactions', 'enabled'],
            true,
          ),
          pickup: reactionContentAt(
            raw,
            ['workflows', 'pr_maintainer', 'comment_reactions', 'pickup'],
            'eyes',
          ),
          replied: reactionContentAt(
            raw,
            ['workflows', 'pr_maintainer', 'comment_reactions', 'replied'],
            'rocket',
          ),
        },
        checkWaitMs: checkWaitMsAt(
          raw,
          ['workflows', 'pr_maintainer', 'check_wait_ms'],
          DEFAULT_PR_MAINTAINER_CHECK_WAIT_MS,
        ),
      },
      logReviewer: {
        enabled: booleanAt(raw, ['workflows', 'log_reviewer', 'enabled'], false),
        repos: logReviewRepos,
        scanIntervalMin: numberAt(raw, ['workflows', 'log_reviewer', 'scan_interval_min'], 60),
        lookbackMin: numberAt(raw, ['workflows', 'log_reviewer', 'lookback_min'], 60),
        maxConcurrentRuns: numberAt(raw, ['workflows', 'log_reviewer', 'max_concurrent_runs'], 2),
        investigationConfidenceThreshold: numberAt(
          raw,
          ['workflows', 'log_reviewer', 'investigation_confidence_threshold'],
          0.7,
        ),
        dryRun: booleanAt(raw, ['workflows', 'log_reviewer', 'dry_run'], false),
        checkWaitMs: checkWaitMsAt(
          raw,
          ['workflows', 'log_reviewer', 'check_wait_ms'],
          DEFAULT_LOG_REVIEWER_CHECK_WAIT_MS,
        ),
      },
      fixImplementer: {
        enabled: booleanAt(raw, ['workflows', 'fix_implementer', 'enabled'], true),
        maxConcurrentRuns: numberAt(
          raw,
          ['workflows', 'fix_implementer', 'max_concurrent_runs'],
          2,
        ),
        maxHandoffsPerRun: numberAt(
          raw,
          ['workflows', 'fix_implementer', 'max_handoffs_per_run'],
          3,
        ),
        maxIterations: numberAt(raw, ['workflows', 'fix_implementer', 'max_iterations'], 2),
        checkWaitMs: checkWaitMsAt(
          raw,
          ['workflows', 'fix_implementer', 'check_wait_ms'],
          DEFAULT_FIX_IMPLEMENTER_CHECK_WAIT_MS,
        ),
      },
      requestRouter: {
        enabled: booleanAt(raw, ['workflows', 'request_router', 'enabled'], false),
        maxConcurrentRuns: numberAt(raw, ['workflows', 'request_router', 'max_concurrent_runs'], 1),
        checkWaitMs: checkWaitMsAt(
          raw,
          ['workflows', 'request_router', 'check_wait_ms'],
          DEFAULT_REQUEST_ROUTER_CHECK_WAIT_MS,
        ),
      },
      linearImplementer: {
        enabled: booleanAt(raw, ['workflows', 'linear_implementer', 'enabled'], false),
        maxConcurrentRuns: numberAt(
          raw,
          ['workflows', 'linear_implementer', 'max_concurrent_runs'],
          1,
        ),
        apiTokenEnv: stringAt(
          raw,
          ['workflows', 'linear_implementer', 'api_token_env'],
          'LINEAR_APP_TOKEN',
        ),
        clientIdEnv: stringAt(
          raw,
          ['workflows', 'linear_implementer', 'client_id_env'],
          'LINEAR_CLIENT_ID',
        ),
        clientSecretEnv: stringAt(
          raw,
          ['workflows', 'linear_implementer', 'client_secret_env'],
          'LINEAR_CLIENT_SECRET',
        ),
        tokenRefreshMin: numberAt(
          raw,
          ['workflows', 'linear_implementer', 'token_refresh_min'],
          1440,
        ),
        webhookSecretEnv: stringAt(
          raw,
          ['workflows', 'linear_implementer', 'webhook_secret_env'],
          'LINEAR_WEBHOOK_SECRET',
        ),
        teamRepos: linearTeamReposAt(raw, ['workflows', 'linear_implementer', 'team_repos']),
        maxIterations: numberAt(raw, ['workflows', 'linear_implementer', 'max_iterations'], 15),
        verifyEffort: effortAt(raw, ['workflows', 'linear_implementer', 'verify_effort'], 'high'),
        checkWaitMs: checkWaitMsAt(
          raw,
          ['workflows', 'linear_implementer', 'check_wait_ms'],
          DEFAULT_LINEAR_IMPLEMENTER_CHECK_WAIT_MS,
        ),
      },
    },
    worker: {
      runner: runnerAt(raw, ['worker', 'runner'], 'mock'),
      codexAuthMode: codexAuthModeAt(raw, ['worker', 'codex_auth_mode'], 'capsule'),
      codexAccessTokenEnv: stringAt(
        raw,
        ['worker', 'codex_access_token_env'],
        'CODEX_ACCESS_TOKEN',
      ),
      codexApiKeyEnv: stringAt(raw, ['worker', 'codex_api_key_env'], 'OPENAI_API_KEY'),
      codexCommand: stringAt(raw, ['worker', 'codex_command'], 'codex'),
      codexBypassSandbox: booleanAt(raw, ['worker', 'codex_bypass_sandbox'], true),
      tenkiApiKeyEnv: stringAt(raw, ['worker', 'tenki_api_key_env'], 'TENKI_API_KEY'),
      tenkiApiUrlEnv: stringAt(raw, ['worker', 'tenki_api_url_env'], 'TENKI_API_URL'),
      tenkiProjectIdEnv: stringAt(raw, ['worker', 'tenki_project_id_env'], 'TENKI_PROJECT_ID'),
      tenkiWorkspaceIdEnv: stringAt(
        raw,
        ['worker', 'tenki_workspace_id_env'],
        'TENKI_WORKSPACE_ID',
      ),
      githubTokenEnv: stringAt(raw, ['worker', 'github_token_env'], 'GITHUB_TOKEN'),
      gitAuthorName: stringAt(raw, ['worker', 'git_author_name'], ''),
      gitAuthorEmail: stringAt(raw, ['worker', 'git_author_email'], ''),
      default: workerDefaultAt(raw),
      repos: workerReposAt(raw),
      modelGenerations: modelGenerationsAt(raw),
      workspacePath: stringAt(raw, ['worker', 'workspace_path'], '/home/tenki/workspace'),
      sessionCloseTimeoutMs: strictPositiveNumberAt(
        raw,
        ['worker', 'session_close_timeout_ms'],
        30_000,
      ),
      maxSandboxReadyAttempts: strictPositiveIntegerAt(
        raw,
        ['worker', 'max_sandbox_ready_attempts'],
        2,
      ),
      sandboxReadyBackoffBaseMs: strictPositiveNumberAt(
        raw,
        ['worker', 'sandbox_ready_backoff_base_ms'],
        1_000,
      ),
      sandboxReadyBackoffJitterMs: strictNonNegativeNumberAt(
        raw,
        ['worker', 'sandbox_ready_backoff_jitter_ms'],
        0,
      ),
      implementationEffort: effortAt(raw, ['worker', 'implementation_effort'], 'xhigh'),
      triageEffort: effortAt(raw, ['worker', 'triage_effort'], 'medium'),
      orchestratorId: stringAt(raw, ['worker', 'orchestrator_id'], 'jardinero'),
      sandboxPauseRetentionMs: strictPositiveNumberAt(
        raw,
        ['worker', 'sandbox_pause_retention_ms'],
        3_600_000,
      ),
      sandboxReaperIntervalMin: strictNonNegativeNumberAt(
        raw,
        ['worker', 'sandbox_reaper_interval_min'],
        5,
      ),
    },
    githubApp: {
      appIdEnv: stringAt(raw, ['github_app', 'app_id_env'], 'JARDINERO_AGENT_APP_ID'),
      installIdEnv: stringAt(raw, ['github_app', 'install_id_env'], 'JARDINERO_AGENT_INSTALL_ID'),
      privateKeyEnv: stringAt(
        raw,
        ['github_app', 'private_key_env'],
        'JARDINERO_AGENT_PRIVATE_KEY',
      ),
      tokenRefreshMin: numberAt(raw, ['github_app', 'token_refresh_min'], 10),
      webhookSecretEnv: stringAt(
        raw,
        ['github_app', 'webhook_secret_env'],
        'JARDINERO_AGENT_WEBHOOK_SECRET',
      ),
    },
    discord: {
      enabled: booleanAt(raw, ['discord', 'enabled'], false),
      applicationIdEnv: stringAt(raw, ['discord', 'application_id_env'], 'DISCORD_APPLICATION_ID'),
      publicKeyEnv: stringAt(raw, ['discord', 'public_key_env'], 'DISCORD_PUBLIC_KEY'),
      botTokenEnv: stringAt(raw, ['discord', 'bot_token_env'], 'DISCORD_BOT_TOKEN'),
      allowedRoleIds: stringListAt(raw, ['discord', 'allowed_role_ids']),
      repoChannels: stringRecordAt(raw, ['discord', 'repo_channels'], {}),
      defaultChannelId: stringAt(raw, ['discord', 'default_channel_id'], ''),
      alertsChannelId: stringAt(raw, ['discord', 'alerts_channel_id'], ''),
    },
    people: peopleAt(raw),
  };

  validateWorkflowConfig(config);
  validateDiscordConfig(config.discord);
  validatePeopleConfig(config.people);
  validateServerPublicUrl(config.server.publicUrl);
  assertWorkerGenerationsResolve(config.worker);
  // A tenki runner with no resolvable default image boots fine but fails opaquely at
  // sandbox creation; catch the old flat `worker.image` config (now `worker.default`).
  if (config.worker.runner === 'tenki' && config.worker.default.image.trim().length === 0) {
    throw new Error(
      'worker.default.image is required when worker.runner is "tenki"; the flat worker.image key was replaced by worker.default.image.',
    );
  }
  return config;
}

// workflowConcurrencies is how many sandboxes each machine may run at once, the cap the
// pool enforces and the dashboard shows.
export function workflowConcurrencies(config: AppConfig): Record<WorkflowType, number> {
  return {
    request_router: config.workflows.requestRouter.maxConcurrentRuns,
    linear_implementer: config.workflows.linearImplementer.maxConcurrentRuns,
    fix_implementer: config.workflows.fixImplementer.maxConcurrentRuns,
    log_reviewer: config.workflows.logReviewer.maxConcurrentRuns,
    pr_maintainer: config.workflows.prMaintainer.maxConcurrentRuns,
  };
}

// discordChannelForRepository is where a repository's work is announced: its own channel,
// or the default, so an announcement is never dropped for want of a destination.
export function discordChannelForRepository(
  config: AppConfig,
  repositoryFullName: string,
): string | undefined {
  const normalizedRepo = repositoryFullName.trim().toLowerCase();
  for (const [repo, channelId] of Object.entries(config.discord.repoChannels)) {
    if (repo.trim().toLowerCase() === normalizedRepo) return channelId;
  }
  return config.discord.defaultChannelId || undefined;
}

// repositoriesForDiscordChannel is every repository that reports to a channel, in the
// order the config lists them. Several may share one, so the caller decides what to do
// with more than one rather than being handed an arbitrary pick.
export function repositoriesForDiscordChannel(config: AppConfig, channelId: string): string[] {
  const normalizedChannelId = channelId.trim();
  return Object.entries(config.discord.repoChannels)
    .filter(([, mappedChannelId]) => mappedChannelId.trim() === normalizedChannelId)
    .map(([repo]) => repo);
}

// personForDiscordUserId, personForGithubLogin and personForLinearUserId are how an event
// that arrives under one identity is answered under another. The config is the only place
// people are declared, so a change to them takes a restart and nothing else.
export function personForDiscordUserId(
  config: AppConfig,
  discordUserId: string,
): PersonConfig | undefined {
  return config.people.find((person) => person.discordUserId === discordUserId.trim());
}

export function personForGithubLogin(
  config: AppConfig,
  githubLogin: string,
): PersonConfig | undefined {
  const normalizedLogin = githubLogin.trim().toLowerCase();
  return config.people.find((person) => person.githubLogin?.toLowerCase() === normalizedLogin);
}

export function personForLinearUserId(
  config: AppConfig,
  linearUserId: string,
): PersonConfig | undefined {
  return config.people.find((person) => person.linearUserId === linearUserId.trim());
}

// repositoryForLinearTeamKey answers the repository a Linear team's work lands in, which is
// what the team's prefix in a ticket identifier says.
export function repositoryForLinearTeamKey(config: AppConfig, teamKey: string): string | undefined {
  const normalized = teamKey.trim().toLowerCase();
  for (const [key, routing] of Object.entries(config.workflows.linearImplementer.teamRepos)) {
    if (key.trim().toLowerCase() !== normalized) continue;
    return typeof routing === 'string' ? routing : routing.default;
  }
  return undefined;
}

// linearTeamKeysForRepository answers every Linear team whose issues are implemented in a
// repository, which is what turns a bare ticket number into an identifier.
export function linearTeamKeysForRepository(
  config: AppConfig,
  repositoryFullName: string,
): string[] {
  const normalizedRepo = repositoryFullName.trim().toLowerCase();
  const keys: string[] = [];
  for (const [teamKey, routing] of Object.entries(config.workflows.linearImplementer.teamRepos)) {
    const repos =
      typeof routing === 'string'
        ? [routing]
        : [routing.default, ...Object.values(routing.projects), ...routing.repos];
    if (repos.some((repo) => repo.trim().toLowerCase() === normalizedRepo)) keys.push(teamKey);
  }
  return keys;
}

// workerRepoTarget answers a repo's own image and generation, because its image may
// only support a given Codex generation; anything it omits inherits `worker.default`.
export function workerRepoTarget(
  config: AppConfig,
  repo: string | undefined,
): WorkerRepoTarget | undefined {
  const normalizedRepo = (repo ?? '').trim().toLowerCase();
  if (!normalizedRepo) return undefined;
  for (const [key, target] of Object.entries(config.worker.repos)) {
    if (key.trim().toLowerCase() === normalizedRepo) return target;
  }
  return undefined;
}

// configuredRepositoryNames is the repositories the config declares we work in: the
// scan targets, every repository the Linear routing can reach, and every one a Discord
// channel is mapped to.
export function configuredRepositoryNames(config: AppConfig): string[] {
  const names = new Set<string>();
  for (const target of config.workflows.logReviewer.repos) names.add(target.repo);
  for (const repo of Object.keys(config.discord.repoChannels)) names.add(repo);
  for (const routing of Object.values(config.workflows.linearImplementer.teamRepos)) {
    if (typeof routing === 'string') {
      names.add(routing);
      continue;
    }
    names.add(routing.default);
    for (const repo of Object.values(routing.projects)) names.add(repo);
    for (const repo of routing.repos) names.add(repo);
  }
  return [...names].filter((name) => name.length > 0).sort();
}

// RepoConfigGap is a repository we work in that is missing a piece named somewhere else.
export interface RepoConfigGap {
  repositoryFullName: string;
  missing: string[];
}

// validateRepoConfig answers what every repository we work in still lacks. Each piece is
// written where its subsystem is configured, so a repository missing one is only visible
// reading them together.
export function validateRepoConfig(config: AppConfig): RepoConfigGap[] {
  const gaps: RepoConfigGap[] = [];
  for (const repositoryFullName of configuredRepositoryNames(config)) {
    const missing: string[] = [];
    if (!discordChannelOwnedBy(config, repositoryFullName)) {
      missing.push('no Discord channel of its own, so its work is announced in the default one');
    }
    if (!workerRepoTarget(config, repositoryFullName)) {
      missing.push('no worker image of its own, so it runs the default one');
    }
    if (missing.length > 0) gaps.push({ repositoryFullName, missing });
  }
  return gaps;
}

// Which channel names this repository, unlike `discordChannelForRepository`, which falls
// back to the default.
function discordChannelOwnedBy(config: AppConfig, repositoryFullName: string): string | undefined {
  const normalizedRepo = repositoryFullName.trim().toLowerCase();
  for (const [repo, channelId] of Object.entries(config.discord.repoChannels)) {
    if (repo.trim().toLowerCase() === normalizedRepo) return channelId;
  }
  return undefined;
}

export function resolveWorkerImage(config: AppConfig, repo: string | undefined): string {
  return (workerRepoTarget(config, repo)?.image ?? config.worker.default.image).trim();
}

// resolveWorkerResources answers the sandbox sizing for a repo: the per-repo block wins
// as a unit over `worker.default`.
export function resolveWorkerResources(
  config: AppConfig,
  repo: string | undefined,
): WorkerResources | undefined {
  return workerRepoTarget(config, repo)?.resources ?? config.worker.default.resources;
}

// resolveWorkerSecretEnvs answers the env var names a repo's sandboxes are given.
export function resolveWorkerSecretEnvs(config: AppConfig, repo: string | undefined): string[] {
  return workerRepoTarget(config, repo)?.secretEnvs ?? [];
}

export function resolveWorkerGeneration(config: AppConfig, repo: string | undefined): string {
  return (
    workerRepoTarget(config, repo)?.model?.generation ?? config.worker.default.model.generation
  );
}

export function resolveWorkerMaxEffort(config: AppConfig, repo: string | undefined): CodexEffort {
  return workerRepoTarget(config, repo)?.model?.maxEffort ?? config.worker.default.model.maxEffort;
}

// resolveSeatModel answers the model a seat runs on a repo: the repo's generation
// profile, with the seat's own entry when the generation defines one.
export function resolveSeatModel(
  config: AppConfig,
  repo: string | undefined,
  seat: string,
): string {
  const generation = resolveWorkerGeneration(config, repo);
  const profile = config.worker.modelGenerations[generation];
  if (!profile) return '';
  return profile[seat] ?? profile.implementation ?? '';
}

// clampEffort holds a seat's requested effort under the repo's ceiling, because gpt-5.5
// rejects `max` and a 5.5 image caps at xhigh.
export function clampEffort(base: CodexEffort, cap: CodexEffort): CodexEffort {
  return EFFORT_RANK[base] <= EFFORT_RANK[cap] ? base : cap;
}

function resolveFromRoot(rootDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function valueAt(raw: RawConfig, keys: string[]): unknown {
  let cursor: unknown = raw;
  for (const key of keys) {
    if (typeof cursor !== 'object' || cursor === null || !(key in cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function stringAt(raw: RawConfig, keys: string[], fallback: string): string {
  const value = valueAt(raw, keys);
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function numberAt(raw: RawConfig, keys: string[], fallback: number): number {
  const value = valueAt(raw, keys);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanAt(raw: RawConfig, keys: string[], fallback: boolean): boolean {
  const value = valueAt(raw, keys);
  return typeof value === 'boolean' ? value : fallback;
}

// stringListAt refuses a malformed list instead of reading it as empty: the lists it reads
// grant access, and an empty one grants none.
function stringListAt(raw: RawConfig, keys: string[]): string[] {
  const value = valueAt(raw, keys);
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string' && item.trim().length > 0)
  ) {
    throw new Error(`${keys.join('.')} must be a list of non-empty strings`);
  }
  return value.map((item) => item.trim());
}

function positiveNumberAt(raw: RawConfig, keys: string[], fallback: number): number {
  const value = numberAt(raw, keys, fallback);
  if (value <= 0) {
    throw new Error(`${keys.join('.')} must be greater than 0`);
  }
  return value;
}

function strictPositiveNumberAt(raw: RawConfig, keys: string[], fallback: number): number {
  const rawValue = valueAt(raw, keys);
  if (rawValue !== undefined && (typeof rawValue !== 'number' || !Number.isFinite(rawValue))) {
    throw new Error(`${keys.join('.')} must be a finite number`);
  }
  const value = rawValue ?? fallback;
  if (value <= 0) {
    throw new Error(`${keys.join('.')} must be greater than 0`);
  }
  return value;
}

function strictNonNegativeNumberAt(raw: RawConfig, keys: string[], fallback: number): number {
  const rawValue = valueAt(raw, keys);
  if (rawValue !== undefined && (typeof rawValue !== 'number' || !Number.isFinite(rawValue))) {
    throw new Error(`${keys.join('.')} must be a finite number`);
  }
  const value = rawValue ?? fallback;
  if (value < 0) {
    throw new Error(`${keys.join('.')} must not be negative`);
  }
  return value;
}

function positiveIntegerAt(raw: RawConfig, keys: string[], fallback: number): number {
  const value = positiveNumberAt(raw, keys, fallback);
  if (!Number.isInteger(value)) {
    throw new Error(`${keys.join('.')} must be a whole number`);
  }
  return value;
}

function strictPositiveIntegerAt(raw: RawConfig, keys: string[], fallback: number): number {
  const value = strictPositiveNumberAt(raw, keys, fallback);
  if (!Number.isInteger(value)) {
    throw new Error(`${keys.join('.')} must be a whole number`);
  }
  return value;
}

function lokiConfigAt(raw: RawConfig): LokiConfig {
  const enabled = booleanAt(raw, ['observability', 'loki', 'enabled'], false);
  const config: LokiConfig = {
    enabled,
    pushUrl: stringAt(raw, ['observability', 'loki', 'push_url'], ''),
    authEnv: stringAt(raw, ['observability', 'loki', 'auth_env'], ''),
    labels: stringRecordAt(raw, ['observability', 'loki', 'labels'], defaultLokiLabels()),
    minLevel: logLevelAt(raw, ['observability', 'loki', 'min_level'], 'info'),
    maxBatchEntries: positiveIntegerAt(raw, ['observability', 'loki', 'max_batch_entries'], 100),
    flushIntervalMs: positiveNumberAt(raw, ['observability', 'loki', 'flush_interval_ms'], 5_000),
    maxBufferEntries: positiveIntegerAt(
      raw,
      ['observability', 'loki', 'max_buffer_entries'],
      1_000,
    ),
    maxRetryAttempts: positiveIntegerAt(raw, ['observability', 'loki', 'max_retry_attempts'], 3),
    retryInitialMs: positiveNumberAt(raw, ['observability', 'loki', 'retry_initial_ms'], 500),
    maxRetryMs: positiveNumberAt(raw, ['observability', 'loki', 'max_retry_ms'], 5_000),
    pushTimeoutMs: positiveNumberAt(raw, ['observability', 'loki', 'push_timeout_ms'], 5_000),
  };
  if (config.maxBatchEntries > config.maxBufferEntries) {
    throw new Error('observability.loki.max_batch_entries must be <= max_buffer_entries');
  }
  if (config.retryInitialMs > config.maxRetryMs) {
    throw new Error('observability.loki.retry_initial_ms must be <= max_retry_ms');
  }
  if (enabled) {
    validateLokiPushUrl(config.pushUrl);
    if (config.minLevel === 'silent') {
      throw new Error('observability.loki.min_level must not be "silent" when Loki is enabled');
    }
  }
  return config;
}

function defaultLokiLabels(): Record<string, string> {
  return {
    app: 'jardinero',
    env: process.env.NODE_ENV?.trim() || 'development',
  };
}

function stringRecordAt(
  raw: RawConfig,
  keys: string[],
  fallback: Record<string, string>,
): Record<string, string> {
  const value = valueAt(raw, keys);
  if (value === undefined) return fallback;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${keys.join('.')} must be an object with string values`);
  }
  const entries = Object.entries(value);
  if (!entries.every(([key, item]) => key.trim().length > 0 && typeof item === 'string')) {
    throw new Error(
      `${keys.join('.')} must be an object with non-empty string keys and string values`,
    );
  }
  return {
    ...fallback,
    ...Object.fromEntries(entries),
  };
}

// checkWaitMsAt layers per-state overrides on the code defaults, so an environment can
// retune one state without restating the map. A state the workflow does not check is
// refused: accepting it would read as a cadence change and do nothing.
function checkWaitMsAt<S extends string>(
  raw: RawConfig,
  keys: string[],
  defaults: Partial<Record<S, number>>,
): Partial<Record<S, number>> {
  const value = valueAt(raw, keys);
  if (value === undefined) return { ...defaults };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${keys.join('.')} must be an object`);
  }
  const result: Partial<Record<S, number>> = { ...defaults };
  for (const [state, wait] of Object.entries(value as Record<string, unknown>)) {
    const path = [...keys, state].join('.');
    if (!(state in defaults)) {
      throw new Error(
        `${path} is not a periodically checked state; expected one of ${Object.keys(defaults).join(', ')}`,
      );
    }
    if (typeof wait !== 'number' || !Number.isFinite(wait) || wait < 0) {
      throw new Error(`${path} must be a non-negative number of milliseconds`);
    }
    result[state as S] = wait;
  }
  return result;
}

function logLevelAt(raw: RawConfig, keys: string[], fallback: LogLevel): LogLevel {
  const rawValue = valueAt(raw, keys);
  if (rawValue !== undefined && typeof rawValue !== 'string') {
    throw new Error(`${keys.join('.')} must be a string log level`);
  }
  const value = rawValue ?? fallback;
  if (
    value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error' ||
    value === 'silent'
  ) {
    return value;
  }
  throw new Error(`${keys.join('.')} must be one of "debug", "info", "warn", "error", or "silent"`);
}

function validateLokiPushUrl(value: string): void {
  if (value.trim().length === 0) {
    throw new Error('observability.loki.push_url must be a valid URL when Loki is enabled');
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error('observability.loki.push_url must be a valid URL when Loki is enabled');
  }
}

// validateServerPublicUrl accepts empty, which only omits the dashboard link, but a set
// value must be a real http or https URL so a typo is caught at boot.
function validateServerPublicUrl(value: string): void {
  if (value.trim().length === 0) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error('server.public_url must be a valid http or https URL when set');
  }
}

function linearTeamReposAt(raw: RawConfig, keys: string[]): Record<string, LinearTeamRepoConfig> {
  const value = valueAt(raw, keys);
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${keys.join('.')} must be an object`);
  }
  const result: Record<string, LinearTeamRepoConfig> = {};
  for (const [teamKey, item] of Object.entries(value as Record<string, unknown>)) {
    const path = [...keys, teamKey].join('.');
    if (typeof item === 'string' && item.length > 0) {
      result[teamKey] = item;
      continue;
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`${path} must be a repo string or routing object`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.default !== 'string' || record.default.length === 0) {
      throw new Error(`${path}.default must be a non-empty repo string`);
    }
    const projects = record.projects;
    if (
      projects !== undefined &&
      (typeof projects !== 'object' || projects === null || Array.isArray(projects))
    ) {
      throw new Error(`${path}.projects must be an object with string values`);
    }
    const projectRepos: Record<string, string> = {};
    for (const [projectKey, repo] of Object.entries((projects ?? {}) as Record<string, unknown>)) {
      if (projectKey.trim().length === 0 || typeof repo !== 'string' || repo.length === 0) {
        throw new Error(
          `${path}.projects must be an object with non-empty string keys and string values`,
        );
      }
      projectRepos[projectKey] = repo;
    }
    result[teamKey] = {
      default: record.default,
      projects: projectRepos,
      repos: linearAdditionalReposAt(record.repos, `${path}.repos`),
    };
  }
  return result;
}

function linearAdditionalReposAt(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be a list of repo strings`);
  }
  return value.map((repo, index) => {
    if (typeof repo !== 'string') {
      throw new Error(`${path}[${index}] must be a string`);
    }
    if (repo.length === 0) {
      throw new Error(`${path}[${index}] must be a non-empty repo string`);
    }
    return repo;
  });
}

function objectOrEmpty(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function workerModelRefAt(value: unknown, path: string, fallback: WorkerModelRef): WorkerModelRef {
  if (value === undefined) return fallback;
  const obj = objectOrEmpty(value, path);
  const generation =
    typeof obj.generation === 'string' && obj.generation.trim().length > 0
      ? obj.generation.trim()
      : fallback.generation;
  let maxEffort = fallback.maxEffort;
  if (obj.max_effort !== undefined) {
    if (
      typeof obj.max_effort !== 'string' ||
      !CODEX_EFFORTS.includes(obj.max_effort as CodexEffort)
    ) {
      throw new Error(`${path}.max_effort must be one of ${CODEX_EFFORTS.join(', ')}`);
    }
    maxEffort = obj.max_effort as CodexEffort;
  }
  return { generation, maxEffort };
}

function workerResourcesAt(value: unknown, path: string): WorkerResources | undefined {
  if (value === undefined) return undefined;
  const obj = objectOrEmpty(value, path);
  const read = (key: string): number => {
    const n = obj[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
      throw new Error(`${path}.${key} must be a positive integer`);
    }
    return n;
  };
  // Both are required as a unit; a partial block is a config mistake, so fail loud.
  return { cpuCores: read('cpu_cores'), memoryMb: read('memory_mb') };
}

function workerSecretEnvsAt(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${path} must be an array of env var names`);
  return value.map((name, index) => {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error(`${path}[${index}] must be a non-empty env var name`);
    }
    return name.trim();
  });
}

function workerDefaultAt(raw: RawConfig): WorkerTarget {
  const obj = objectOrEmpty(valueAt(raw, ['worker', 'default']), 'worker.default');
  const resources = workerResourcesAt(obj.resources, 'worker.default.resources');
  return {
    image: typeof obj.image === 'string' ? obj.image : '',
    model: workerModelRefAt(obj.model, 'worker.default.model', {
      generation: 'gpt-5.6',
      maxEffort: 'xhigh',
    }),
    ...(resources ? { resources } : {}),
  };
}

function workerReposAt(raw: RawConfig): Record<string, WorkerRepoTarget> {
  const value = valueAt(raw, ['worker', 'repos']);
  if (value === undefined) return {};
  const obj = objectOrEmpty(value, 'worker.repos');
  const fallbackModel = workerDefaultAt(raw).model;
  const result: Record<string, WorkerRepoTarget> = {};
  for (const [repo, entry] of Object.entries(obj)) {
    const e = objectOrEmpty(entry, `worker.repos.${repo}`);
    const target: WorkerRepoTarget = {};
    if (typeof e.image === 'string' && e.image.trim().length > 0) target.image = e.image.trim();
    if (e.model !== undefined) {
      target.model = workerModelRefAt(e.model, `worker.repos.${repo}.model`, fallbackModel);
    }
    const resources = workerResourcesAt(e.resources, `worker.repos.${repo}.resources`);
    if (resources) target.resources = resources;
    const secretEnvs = workerSecretEnvsAt(e.secret_envs, `worker.repos.${repo}.secret_envs`);
    if (secretEnvs) target.secretEnvs = secretEnvs;
    result[repo] = target;
  }
  return result;
}

function modelGenerationsAt(raw: RawConfig): Record<string, ModelGeneration> {
  // Code owns the generation-to-seat mapping; config may override or add generations.
  const merged: Record<string, ModelGeneration> = {
    'gpt-5.6': { implementation: 'gpt-5.6-sol', triage: 'gpt-5.6-terra' },
    'gpt-5.5': { implementation: 'gpt-5.5' },
  };
  const value = valueAt(raw, ['worker', 'model_generations']);
  if (value === undefined) return merged;
  const obj = objectOrEmpty(value, 'worker.model_generations');
  for (const [gen, profile] of Object.entries(obj)) {
    const p = objectOrEmpty(profile, `worker.model_generations.${gen}`);
    const seats: ModelGeneration = {};
    for (const [seat, model] of Object.entries(p)) {
      if (typeof model !== 'string' || model.trim().length === 0) {
        throw new Error(`worker.model_generations.${gen}.${seat} must be a non-empty string`);
      }
      seats[seat] = model.trim();
    }
    // Merge per-seat so overriding one seat of a built-in generation keeps the others.
    const profileForGen = { ...merged[gen], ...seats };
    if (
      typeof profileForGen.implementation !== 'string' ||
      profileForGen.implementation.length === 0
    ) {
      throw new Error(`worker.model_generations.${gen} must define an "implementation" model`);
    }
    merged[gen] = profileForGen;
  }
  return merged;
}

function assertWorkerGenerationsResolve(worker: AppConfig['worker']): void {
  const known = new Set(Object.keys(worker.modelGenerations));
  const referenced: Array<{ where: string; generation: string }> = [
    { where: 'worker.default', generation: worker.default.model.generation },
    ...Object.entries(worker.repos)
      .filter(([, target]) => target.model)
      .map(([repo, target]) => ({
        where: `worker.repos.${repo}`,
        generation: target.model!.generation,
      })),
  ];
  for (const { where, generation } of referenced) {
    if (!known.has(generation)) {
      throw new Error(
        `${where} references unknown model generation "${generation}". Defined: ${[...known].join(', ')}`,
      );
    }
  }
}

function peopleAt(raw: RawConfig): PersonConfig[] {
  const value = valueAt(raw, ['people']);
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('people must be a list');
  return value.map((item, index) => personAt(item, index));
}

function personAt(value: unknown, index: number): PersonConfig {
  const at = `people[${index}]`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${at} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const person: PersonConfig = {
    discordUserId: textFieldAt(record, 'discord_user_id', at),
    discordUsername: textFieldAt(record, 'discord_username', at),
  };
  const githubLogin = optionalTextFieldAt(record, 'github_login', at);
  if (githubLogin) person.githubLogin = githubLogin;
  const linearUserId = optionalTextFieldAt(record, 'linear_user_id', at);
  if (linearUserId) person.linearUserId = linearUserId;
  return person;
}

function textFieldAt(record: Record<string, unknown>, key: string, at: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${at}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalTextFieldAt(
  record: Record<string, unknown>,
  key: string,
  at: string,
): string | undefined {
  return record[key] === undefined ? undefined : textFieldAt(record, key, at);
}

function logReviewReposAt(raw: RawConfig): LogReviewRepoConfig[] {
  const value = valueAt(raw, ['workflows', 'log_reviewer', 'repos']);
  if (Array.isArray(value)) {
    return value.map((item, index) => logReviewRepoAt(item, index));
  }
  return [];
}

function logReviewRepoAt(value: unknown, index: number): LogReviewRepoConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`workflows.log_reviewer.repos[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.repo !== 'string' || record.repo.trim().length === 0) {
    throw new Error(`workflows.log_reviewer.repos[${index}].repo must be a non-empty string`);
  }
  if (
    !Array.isArray(record.services) ||
    !record.services.every((item) => typeof item === 'string')
  ) {
    throw new Error(`workflows.log_reviewer.repos[${index}].services must be a list of strings`);
  }
  const output: LogReviewRepoConfig = {
    repo: record.repo,
    clusters: stringArrayValue(record.clusters),
    services: record.services,
  };
  if (typeof record.namespace === 'string' && record.namespace.trim().length > 0) {
    output.namespace = record.namespace;
  }
  const permissionSignals = permissionSignalsAt(record.permission_signals, index);
  if (permissionSignals) {
    output.permissionSignals = permissionSignals;
  }
  return output;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function numberArrayValue(value: unknown): number[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
    ? value
    : [];
}

function permissionSignalsAt(
  value: unknown,
  index: number,
): LogReviewPermissionSignalsConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`workflows.log_reviewer.repos[${index}].permission_signals must be an object`);
  }
  const record = value as Record<string, unknown>;
  return {
    statusCodes: numberArrayValue(record.status_codes),
    grpcCodes: stringArrayValue(record.grpc_codes),
    keywords: stringArrayValue(record.keywords),
    knownNoise: stringArrayValue(record.known_noise),
  };
}

function runnerAt(raw: RawConfig, keys: string[], fallback: 'mock' | 'tenki'): 'mock' | 'tenki' {
  const value = stringAt(raw, keys, fallback);
  if (value === 'mock' || value === 'tenki') return value;
  throw new Error(`Unsupported worker.runner "${value}". Expected "mock" or "tenki".`);
}

function effortAt(raw: RawConfig, keys: string[], fallback: CodexEffort): CodexEffort {
  const value = stringAt(raw, keys, fallback);
  if (CODEX_EFFORTS.includes(value as CodexEffort)) return value as CodexEffort;
  throw new Error(
    `Unsupported ${keys.join('.')} "${value}". Expected "low", "medium", "high", "xhigh", or "max".`,
  );
}

function reactionContentAt(
  raw: RawConfig,
  keys: string[],
  fallback: ReactionContent,
): ReactionContent {
  const value = stringAt(raw, keys, fallback);
  if (isReactionContent(value)) return value;
  throw new Error(
    `Unsupported ${keys.join('.')} "${value}". GitHub reactions must be one of +1, -1, laugh, confused, heart, hooray, rocket, eyes.`,
  );
}

function codexAuthModeAt(
  raw: RawConfig,
  keys: string[],
  fallback: 'capsule' | 'access_token' | 'api_key',
): 'capsule' | 'access_token' | 'api_key' {
  const value = stringAt(raw, keys, fallback);
  if (value === 'capsule' || value === 'access_token' || value === 'api_key') return value;
  throw new Error(
    `Unsupported worker.codex_auth_mode "${value}". Expected "capsule", "access_token", or "api_key".`,
  );
}

function mcpAuthAt(
  raw: RawConfig,
  keys: string[],
  fallback: 'oauth' | 'service_account' | 'none',
): 'oauth' | 'service_account' | 'none' {
  const value = stringAt(raw, keys, fallback);
  if (value === 'oauth' || value === 'service_account' || value === 'none') return value;
  throw new Error(
    `Unsupported MCP auth "${value}". Expected "oauth", "service_account", or "none".`,
  );
}

function validateWorkflowConfig(config: AppConfig): void {
  if (config.sandboxes.maxConcurrentRuns < 1) {
    throw new Error('sandboxes.max_concurrent_runs must be at least 1');
  }
  if (config.workflows.logReviewer.enabled) {
    if (config.workflows.logReviewer.repos.length === 0) {
      throw new Error('workflows.log_reviewer must include at least one repo');
    }
    const seenLogReviewEntries = new Set<string>();
    for (const repo of config.workflows.logReviewer.repos) {
      if (repo.services.length === 0) {
        throw new Error(
          `workflows.log_reviewer repo ${repo.repo} must include at least one service`,
        );
      }
      // A repo may appear once per namespace, but repo+namespace is the entry
      // identity (dedup key, cron resolution), so a duplicate pair would collide.
      const identity = `${repo.repo}#${repo.namespace ?? ''}`;
      if (seenLogReviewEntries.has(identity)) {
        const scope = repo.namespace
          ? `repo ${repo.repo} namespace ${repo.namespace}`
          : `repo ${repo.repo}`;
        throw new Error(`workflows.log_reviewer has a duplicate entry for ${scope}`);
      }
      seenLogReviewEntries.add(identity);
    }
  }
  if (config.workflows.fixImplementer.maxHandoffsPerRun < 1) {
    throw new Error('workflows.fix_implementer.max_handoffs_per_run must be at least 1');
  }
  if (config.workflows.linearImplementer.enabled) {
    if (Object.keys(config.workflows.linearImplementer.teamRepos).length === 0) {
      throw new Error(
        'workflows.linear_implementer.team_repos must map at least one team key to a repo',
      );
    }
    for (const [teamKey, repoConfig] of Object.entries(
      config.workflows.linearImplementer.teamRepos,
    )) {
      if (typeof repoConfig === 'string') {
        validateRepositorySlug(repoConfig, `workflows.linear_implementer.team_repos.${teamKey}`);
        continue;
      }
      validateRepositorySlug(
        repoConfig.default,
        `workflows.linear_implementer.team_repos.${teamKey}.default`,
      );
      for (const [projectKey, repo] of Object.entries(repoConfig.projects)) {
        validateRepositorySlug(
          repo,
          `workflows.linear_implementer.team_repos.${teamKey}.projects.${projectKey}`,
        );
      }
      for (const [index, repo] of repoConfig.repos.entries()) {
        validateRepositorySlug(
          repo,
          `workflows.linear_implementer.team_repos.${teamKey}.repos[${index}]`,
        );
      }
    }
  }
  if (
    config.workflows.linearImplementer.maxIterations < 0 ||
    !Number.isInteger(config.workflows.linearImplementer.maxIterations)
  ) {
    throw new Error('workflows.linear_implementer.max_iterations must be a whole number >= 0');
  }
  if (
    config.workflows.fixImplementer.maxIterations < 0 ||
    !Number.isInteger(config.workflows.fixImplementer.maxIterations)
  ) {
    throw new Error('workflows.fix_implementer.max_iterations must be a whole number >= 0');
  }
  if (!config.worker.workspacePath.startsWith('/')) {
    throw new Error('worker.workspace_path must be an absolute path inside the worker sandbox');
  }
}

function validateRepositorySlug(repo: string, path: string): void {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(`${path} must be an "owner/repo" slug`);
  }
}

function validateDiscordConfig(discord: AppConfig['discord']): void {
  for (const [repo, channelId] of Object.entries(discord.repoChannels)) {
    validateRepositorySlug(repo, `discord.repo_channels.${repo}`);
    if (channelId.trim().length === 0) {
      throw new Error(`discord.repo_channels.${repo} must name a channel id`);
    }
  }
  if (!discord.enabled) return;
  if (discord.allowedRoleIds.length === 0) {
    throw new Error(
      'discord.allowed_role_ids must list at least one role id when discord is enabled',
    );
  }
  if (Object.keys(discord.repoChannels).length === 0 && discord.defaultChannelId.length === 0) {
    throw new Error(
      'discord requires discord.repo_channels or discord.default_channel_id when enabled',
    );
  }
}

function validatePeopleConfig(people: PersonConfig[]): void {
  const claimedIdentities = new Map<string, number>();
  people.forEach((person, index) => {
    const identities = [
      ['discord_user_id', person.discordUserId],
      ['discord_username', person.discordUsername],
      ['github_login', person.githubLogin],
      ['linear_user_id', person.linearUserId],
    ] as const;
    for (const [field, value] of identities) {
      if (value === undefined) continue;
      // A login is claimed lowercased because that is how it is looked up: two casings are
      // one claim here instead of an order-dependent answer there. The error still quotes
      // what the config wrote.
      const claim = `${field}=${field === 'github_login' ? value.toLowerCase() : value}`;
      const claimedBy = claimedIdentities.get(claim);
      if (claimedBy !== undefined) {
        throw new Error(`people[${index}].${field} "${value}" is already people[${claimedBy}]`);
      }
      claimedIdentities.set(claim, index);
    }
  });
}
