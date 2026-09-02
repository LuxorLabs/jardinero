import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  type AppConfig,
  clampEffort,
  configuredRepositoryNames,
  discordChannelForRepository,
  linearTeamKeysForRepository,
  repositoryForLinearTeamKey,
  loadConfig,
  validateRepoConfig,
  personForDiscordUserId,
  personForGithubLogin,
  personForLinearUserId,
  repositoriesForDiscordChannel,
  resolveSeatModel,
  resolveWorkerGeneration,
  resolveWorkerImage,
  resolveWorkerMaxEffort,
  resolveWorkerResources,
  resolveWorkerSecretEnvs,
  workflowConcurrencies,
} from './config.js';
import type { LinearTeamRepoConfig } from './config.js';

describe('loadConfig', () => {
  test('When config is empty then should apply all code defaults', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jardinero-config-'));
    try {
      writeFileSync(path.join(root, 'config.yaml'), '{}\n');
      const config = loadConfig('config.yaml', root);

      assert.deepEqual(config, {
        rootDir: root,
        configPath: 'config.yaml',
        server: { host: '0.0.0.0', port: 3000, publicUrl: '' },
        auth: {
          adminTokenEnv: 'ORCHESTRATOR_ADMIN_TOKEN',
        },
        store: {
          dataPath: path.resolve(root, './data'),
          schemaPath: path.resolve(root, './db/schema.sql'),
          backupIntervalMin: 60,
          backupRetentionCount: 24,
        },
        sandboxes: {
          maxConcurrentRuns: 10,
          maxWallClockMin: 30,
        },
        observability: {
          loki: {
            enabled: false,
            pushUrl: '',
            authEnv: '',
            labels: { app: 'jardinero', env: process.env.NODE_ENV?.trim() || 'development' },
            minLevel: 'info',
            maxBatchEntries: 100,
            flushIntervalMs: 5000,
            maxBufferEntries: 1000,
            maxRetryAttempts: 3,
            retryInitialMs: 500,
            maxRetryMs: 5000,
            pushTimeoutMs: 5000,
          },
        },
        mcp: {
          grafana: {
            enabled: false,
            name: 'grafana',
            url: '',
            auth: 'service_account',
            serviceAccountTokenEnv: 'GRAFANA_SA_TOKEN',
            accessTokenEnv: 'GRAFANA_ACCESS_TOKEN',
            clientIdEnv: 'GRAFANA_CLIENT_ID',
            refreshTokenEnv: 'GRAFANA_REFRESH_TOKEN',
          },
        },
        workflows: {
          prMaintainer: {
            enabled: true,
            maxConcurrentRuns: 3,
            maxPushAttempts: 15,
            maxRepliesPerThread: 2,
            pollIntervalMin: 5,
            pollBranchPrefix: 'agent/',
            agentLogin: '',
            commentReactions: { enabled: true, pickup: 'eyes', replied: 'rocket' },
            checkWaitMs: { prm_pending: 60_000, prm_working: 120_000, prm_waiting: 300_000 },
          },
          logReviewer: {
            enabled: false,
            repos: [],
            scanIntervalMin: 60,
            lookbackMin: 60,
            maxConcurrentRuns: 2,
            investigationConfidenceThreshold: 0.7,
            dryRun: false,
            checkWaitMs: { lr_pending: 60_000, lr_working: 120_000 },
          },
          fixImplementer: {
            enabled: true,
            maxConcurrentRuns: 2,
            maxHandoffsPerRun: 3,
            maxIterations: 2,
            checkWaitMs: {
              fi_pending: 60_000,
              fi_implementing: 120_000,
              fi_verifying: 60_000,
              fi_waiting_pr: 3_600_000,
            },
          },
          requestRouter: {
            enabled: false,
            maxConcurrentRuns: 1,
            checkWaitMs: { rr_pending: 60_000, rr_routing: 120_000 },
          },
          linearImplementer: {
            enabled: false,
            maxConcurrentRuns: 1,
            apiTokenEnv: 'LINEAR_APP_TOKEN',
            clientIdEnv: 'LINEAR_CLIENT_ID',
            clientSecretEnv: 'LINEAR_CLIENT_SECRET',
            tokenRefreshMin: 1440,
            webhookSecretEnv: 'LINEAR_WEBHOOK_SECRET',
            teamRepos: {},
            maxIterations: 15,
            verifyEffort: 'high',
            checkWaitMs: {
              li_pending: 60_000,
              li_implementing: 120_000,
              li_verifying: 120_000,
              li_waiting_pr: 3_600_000,
            },
          },
        },
        worker: {
          runner: 'mock',
          codexAuthMode: 'capsule',
          codexAccessTokenEnv: 'CODEX_ACCESS_TOKEN',
          codexApiKeyEnv: 'OPENAI_API_KEY',
          codexCommand: 'codex',
          codexBypassSandbox: true,
          tenkiApiKeyEnv: 'TENKI_API_KEY',
          tenkiApiUrlEnv: 'TENKI_API_URL',
          tenkiProjectIdEnv: 'TENKI_PROJECT_ID',
          tenkiWorkspaceIdEnv: 'TENKI_WORKSPACE_ID',
          freestyleApiKeyEnv: 'FREESTYLE_API_KEY',
          freestyleApiUrlEnv: 'FREESTYLE_API_URL',
          githubTokenEnv: 'GITHUB_TOKEN',
          gitAuthorName: '',
          gitAuthorEmail: '',
          default: { image: '', model: { generation: 'gpt-5.6', maxEffort: 'xhigh' } },
          repos: {},
          modelGenerations: {
            'gpt-5.6': { implementation: 'gpt-5.6-sol', triage: 'gpt-5.6-terra' },
            'gpt-5.5': { implementation: 'gpt-5.5' },
          },
          workspacePath: '/home/tenki/workspace',
          sessionCloseTimeoutMs: 30_000,
          maxSandboxReadyAttempts: 2,
          sandboxReadyBackoffBaseMs: 1_000,
          sandboxReadyBackoffJitterMs: 0,
          implementationEffort: 'xhigh',
          triageEffort: 'medium',
          orchestratorId: 'jardinero',
          sandboxPauseRetentionMs: 3_600_000,
          sandboxReaperIntervalMin: 5,
        },
        githubApp: {
          appIdEnv: 'JARDINERO_AGENT_APP_ID',
          installIdEnv: 'JARDINERO_AGENT_INSTALL_ID',
          privateKeyEnv: 'JARDINERO_AGENT_PRIVATE_KEY',
          tokenRefreshMin: 10,
          webhookSecretEnv: 'JARDINERO_AGENT_WEBHOOK_SECRET',
        },
        discord: {
          enabled: false,
          applicationIdEnv: 'DISCORD_APPLICATION_ID',
          publicKeyEnv: 'DISCORD_PUBLIC_KEY',
          botTokenEnv: 'DISCORD_BOT_TOKEN',
          allowedRoleIds: [],
          repoChannels: {},
          defaultChannelId: '',
          alertsChannelId: '',
        },
        people: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('When the config file is missing then should return error', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jardinero-config-'));
    try {
      assert.throws(() => loadConfig('does-not-exist.yaml', root), /ENOENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Server config the loader refuses', () => {
  test('When the public url is not a url then should return error', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jardinero-config-'));
    try {
      writeFileSync(path.join(root, 'config.yaml'), 'server:\n  public_url: "not-a-url"\n');
      assert.throws(() => loadConfig('config.yaml', root), /server\.public_url must be a valid/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Loki config', () => {
  test('When loki is configured then should read every value it sets', () => {
    const config = loadYamlConfig(`
observability:
  loki:
    enabled: true
    push_url: "https://loki.example.test/loki/api/v1/push"
    auth_env: "LOKI_TOKEN"
    labels:
      team: "platform"
      env: "staging"
    min_level: "warn"
    max_batch_entries: 25
    flush_interval_ms: 1000
    max_buffer_entries: 500
    max_retry_attempts: 4
    retry_initial_ms: 200
    max_retry_ms: 2000
    push_timeout_ms: 3000
`);

    assert.equal(config.observability.loki.enabled, true);
    assert.equal(config.observability.loki.pushUrl, 'https://loki.example.test/loki/api/v1/push');
    assert.equal(config.observability.loki.authEnv, 'LOKI_TOKEN');
    assert.deepEqual(config.observability.loki.labels, {
      app: 'jardinero',
      env: 'staging',
      team: 'platform',
    });
    assert.equal(config.observability.loki.minLevel, 'warn');
    assert.equal(config.observability.loki.maxBatchEntries, 25);
    assert.equal(config.observability.loki.flushIntervalMs, 1000);
    assert.equal(config.observability.loki.maxBufferEntries, 500);
    assert.equal(config.observability.loki.maxRetryAttempts, 4);
    assert.equal(config.observability.loki.retryInitialMs, 200);
    assert.equal(config.observability.loki.maxRetryMs, 2000);
    assert.equal(config.observability.loki.pushTimeoutMs, 3000);
  });

  test('When loki labels are absent then should apply the defaults', () => {
    const config = loadYamlConfig(`
observability:
  loki:
    enabled: false
`);

    assert.deepEqual(config.observability.loki.labels, {
      app: 'jardinero',
      env: process.env.NODE_ENV?.trim() || 'development',
    });
  });

  test('When a loki tuning value is not a number then should fall back to the default', () => {
    const config = loadYamlConfig(`
observability:
  loki:
    flush_interval_ms: "1000"
`);

    assert.equal(config.observability.loki.flushIntervalMs, 5_000);
  });
});

describe('Loki config the loader refuses', () => {
  const positiveKeys = [
    'max_batch_entries',
    'flush_interval_ms',
    'max_buffer_entries',
    'max_retry_attempts',
    'retry_initial_ms',
    'max_retry_ms',
    'push_timeout_ms',
  ];
  const wholeNumberKeys = ['max_batch_entries', 'max_buffer_entries', 'max_retry_attempts'];

  const cases: Array<{ name: string; yaml: string; wantError: RegExp }> = [
    {
      name: 'When the `min_level` is not a level then should return error',
      yaml: `
observability:
  loki:
    min_level: "verbose"
`,
      wantError: /observability\.loki\.min_level must be one of/,
    },
    {
      name: 'When the `min_level` is not a string then should return error',
      yaml: `
observability:
  loki:
    min_level: 123
`,
      wantError: /observability\.loki\.min_level must be a string log level/,
    },
    {
      name: 'When loki is enabled with an empty `push_url` then should return error',
      yaml: `
observability:
  loki:
    enabled: true
    push_url: ""
`,
      wantError: /observability\.loki\.push_url must be a valid URL when Loki is enabled/,
    },
    {
      name: 'When loki is enabled with an unparseable `push_url` then should return error',
      yaml: `
observability:
  loki:
    enabled: true
    push_url: "notaurl"
`,
      wantError: /observability\.loki\.push_url must be a valid URL when Loki is enabled/,
    },
    {
      name: 'When loki is enabled with a silent `min_level` then should return error',
      yaml: `
observability:
  loki:
    enabled: true
    push_url: "https://loki.example.test/loki/api/v1/push"
    min_level: "silent"
`,
      wantError: /observability\.loki\.min_level must not be "silent" when Loki is enabled/,
    },
    {
      name: 'When the batch exceeds the buffer then should return error',
      yaml: `
observability:
  loki:
    max_batch_entries: 200
    max_buffer_entries: 100
`,
      wantError: /observability\.loki\.max_batch_entries must be <= max_buffer_entries/,
    },
    {
      name: 'When the initial retry exceeds the max then should return error',
      yaml: `
observability:
  loki:
    retry_initial_ms: 5000
    max_retry_ms: 1000
`,
      wantError: /observability\.loki\.retry_initial_ms must be <= max_retry_ms/,
    },
    ...positiveKeys.map((key) => ({
      name: `When \`${key}\` is zero then should return error`,
      yaml: `
observability:
  loki:
    ${key}: 0
`,
      wantError: new RegExp(`observability\\.loki\\.${key} must be greater than 0`),
    })),
    ...wholeNumberKeys.map((key) => ({
      name: `When \`${key}\` is fractional then should return error`,
      yaml: `
observability:
  loki:
    ${key}: 0.5
`,
      wantError: new RegExp(`observability\\.loki\\.${key} must be a whole number`),
    })),
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.throws(() => loadYamlConfig(testCase.yaml), testCase.wantError);
    });
  }
});

describe('PR maintainer config', () => {
  test('When the comment reactions are supported then should read them', () => {
    const config = loadWorkflowConfig(
      'pr_maintainer',
      `
    comment_reactions:
      enabled: false
      pickup: "heart"
      replied: "hooray"
`,
    );

    assert.equal(config.workflows.prMaintainer.commentReactions.enabled, false);
    assert.equal(config.workflows.prMaintainer.commentReactions.pickup, 'heart');
    assert.equal(config.workflows.prMaintainer.commentReactions.replied, 'hooray');
  });
});

describe('PR maintainer config the loader refuses', () => {
  test('When a comment reaction is not one GitHub accepts then should return error', () => {
    assert.throws(
      () =>
        loadWorkflowConfig(
          'pr_maintainer',
          `
    comment_reactions:
      pickup: "thumbsup"
`,
        ),
      /Unsupported workflows\.pr_maintainer\.comment_reactions\.pickup/,
    );
  });
});

// Every renamed or removed key went with no back-compat shim, so a stale deploy config
// must fail loud at boot instead of running on the code default.
describe('Log reviewer config the loader refuses', () => {
  test('When a repo and namespace are configured twice then should return error', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jardinero-config-'));
    try {
      writeFileSync(
        path.join(root, 'config.yaml'),
        `
workflows:
  log_reviewer:
    enabled: true
    repos:
      - repo: "acme/webapp"
        namespace: "billing"
        services: ["billing"]
      - repo: "acme/webapp"
        namespace: "billing"
        services: ["billing"]
`,
      );
      assert.throws(
        () => loadConfig('config.yaml', root),
        /workflows\.log_reviewer has a duplicate entry for repo acme\/webapp namespace billing/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('When a repo with no namespace is configured twice then should name only the repo', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jardinero-config-'));
    try {
      writeFileSync(
        path.join(root, 'config.yaml'),
        `
workflows:
  log_reviewer:
    enabled: true
    repos:
      - repo: "acme/testrepo"
        services: ["api"]
      - repo: "acme/testrepo"
        services: ["api"]
`,
      );
      assert.throws(
        () => loadConfig('config.yaml', root),
        (error) => {
          assert.match(
            (error as Error).message,
            /workflows\.log_reviewer has a duplicate entry for repo acme\/testrepo/,
          );
          // No namespace on either entry, so the message must not name one.
          assert.doesNotMatch((error as Error).message, /namespace/);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Fix implementer config the loader refuses', () => {
  const cases: Array<{ name: string; yaml: string; wantError: RegExp }> = [
    {
      name: 'When `max_iterations` is negative then should return error',
      yaml: `
      max_iterations: -1
  `,
      wantError: /workflows\.fix_implementer\.max_iterations must be a whole number >= 0/,
    },
    {
      name: 'When `max_iterations` is fractional then should return error',
      yaml: `
      max_iterations: 0.5
  `,
      wantError: /workflows\.fix_implementer\.max_iterations must be a whole number >= 0/,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.throws(() => loadWorkflowConfig('fix_implementer', testCase.yaml), testCase.wantError);
    });
  }
});

describe('Linear implementer config', () => {
  test('When a team maps to one repo then should read the block', () => {
    const config = loadWorkflowConfig(
      'linear_implementer',
      `
    enabled: true
    max_concurrent_runs: 2
    team_repos:
      JAR: "acme/orchestrator"
`,
    );

    assert.equal(config.workflows.linearImplementer.enabled, true);
    assert.equal(config.workflows.linearImplementer.maxConcurrentRuns, 2);
  });

  // 0 iterations disables verification and opens PRs ready, so it must be accepted.
  test('When `max_iterations` is zero then should disable verification', () => {
    const config = loadWorkflowConfig(
      'linear_implementer',
      `
    max_iterations: 0
`,
    );

    assert.equal(config.workflows.linearImplementer.maxIterations, 0);
  });
});

// Both lists are always read, so a team that names neither routes exactly as it did
// before they existed.
describe('Linear team routing', () => {
  const cases: Array<{ name: string; yaml: string; want: LinearTeamRepoConfig }> = [
    {
      name: 'When a team mapping is an object then should read its project and additional repos',
      yaml: `
      JAR:
        default: "acme/orchestrator"
        projects:
          "Project Name": "acme/web.app"
          "project-id-1": "acme/webapp"
        repos:
          - "acme/cloud"
          - "acme/cookbook"
`,
      want: {
        default: 'acme/orchestrator',
        projects: {
          'Project Name': 'acme/web.app',
          'project-id-1': 'acme/webapp',
        },
        repos: ['acme/cloud', 'acme/cookbook'],
      },
    },
    {
      name: 'When a team mapping names no additional repos then should read an empty list',
      yaml: `
      JAR:
        default: "acme/orchestrator"
        projects:
          "Project Name": "acme/web.app"
`,
      want: {
        default: 'acme/orchestrator',
        projects: { 'Project Name': 'acme/web.app' },
        repos: [],
      },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const config = loadWorkflowConfig(
        'linear_implementer',
        `
    enabled: true
    team_repos:${testCase.yaml}`,
      );

      assert.deepEqual(config.workflows.linearImplementer.teamRepos, { JAR: testCase.want });
    });
  }
});

describe('Linear implementer config the loader refuses', () => {
  const cases: Array<{ name: string; yaml: string; wantError: RegExp }> = [
    {
      name: 'When it is enabled with no team repos then should return error',
      yaml: `
      enabled: true
  `,
      wantError:
        /workflows\.linear_implementer\.team_repos must map at least one team key to a repo/,
    },
    {
      name: 'When a team repo is not a slug then should return error',
      yaml: `
      enabled: true
      team_repos:
        JAR: "not-a-slug"
  `,
      wantError: /workflows\.linear_implementer\.team_repos\.JAR must be an "owner\/repo" slug/,
    },
    {
      name: 'When a team default is not a slug then should return error',
      yaml: `
      enabled: true
      team_repos:
        JAR:
          default: "not-a-slug"
          projects:
            Jardinero: "acme/orchestrator"
  `,
      wantError:
        /workflows\.linear_implementer\.team_repos\.JAR\.default must be an "owner\/repo" slug/,
    },
    {
      name: 'When a team project is not a slug then should return error',
      yaml: `
      enabled: true
      team_repos:
        JAR:
          default: "acme/orchestrator"
          projects:
            Jardinero: "not-a-slug"
  `,
      wantError:
        /workflows\.linear_implementer\.team_repos\.JAR\.projects\.Jardinero must be an "owner\/repo" slug/,
    },
    {
      name: 'When a team mapping has no default then should return error',
      yaml: `
      enabled: true
      team_repos:
        JAR:
          projects:
            Jardinero: "acme/orchestrator"
  `,
      wantError:
        /workflows\.linear_implementer\.team_repos\.JAR\.default must be a non-empty repo string/,
    },
    {
      name: 'When a team projects map is not an object then should return error',
      yaml: `
      enabled: true
      team_repos:
        JAR:
          default: "acme/orchestrator"
          projects: "acme/web.app"
  `,
      wantError:
        /workflows\.linear_implementer\.team_repos\.JAR\.projects must be an object with string values/,
    },
    {
      name: 'When the additional repos are not a list then should return error',
      yaml: `
      enabled: true
      team_repos:
        JAR:
          default: "acme/orchestrator"
          repos: "acme/web.app"
  `,
      wantError: /workflows\.linear_implementer\.team_repos\.JAR\.repos must be a list/,
    },
    {
      name: 'When an additional repo is not a string then should return error',
      yaml: `
      enabled: true
      team_repos:
        JAR:
          default: "acme/orchestrator"
          repos: [42]
  `,
      wantError: /workflows\.linear_implementer\.team_repos\.JAR\.repos\[0\] must be a string/,
    },
    {
      name: 'When an additional repo is empty then should return error',
      yaml: `
      enabled: true
      team_repos:
        JAR:
          default: "acme/orchestrator"
          repos: [""]
  `,
      wantError:
        /workflows\.linear_implementer\.team_repos\.JAR\.repos\[0\] must be a non-empty repo string/,
    },
    {
      name: 'When an additional repo is not a slug then should return error',
      yaml: `
      enabled: true
      team_repos:
        JAR:
          default: "acme/orchestrator"
          repos: ["web.app"]
  `,
      wantError:
        /workflows\.linear_implementer\.team_repos\.JAR\.repos\[0\] must be an "owner\/repo" slug/,
    },
    {
      name: 'When `max_iterations` is negative then should return error',
      yaml: `
      max_iterations: -1
  `,
      wantError: /workflows\.linear_implementer\.max_iterations must be a whole number >= 0/,
    },
    {
      name: 'When `max_iterations` is fractional then should return error',
      yaml: `
      max_iterations: 1.5
  `,
      wantError: /workflows\.linear_implementer\.max_iterations must be a whole number >= 0/,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.throws(
        () => loadWorkflowConfig('linear_implementer', testCase.yaml),
        testCase.wantError,
      );
    });
  }
});

// One reader serves the five workflows, so its branch inventory is one table.
describe('Workflow check wait cadence', () => {
  const cases: Array<{
    name: string;
    workflowKey: string;
    yaml: string;
    read: (config: AppConfig) => Record<string, number | undefined>;
    want: Record<string, number>;
  }> = [
    {
      name: 'When the key is absent then should apply every code default',
      workflowKey: 'request_router',
      yaml: `
    max_concurrent_runs: 2
`,
      read: (config) => config.workflows.requestRouter.checkWaitMs,
      want: { rr_pending: 60_000, rr_routing: 120_000 },
    },
    {
      name: 'When one state is overridden then should keep the defaults of the others',
      workflowKey: 'request_router',
      yaml: `
    check_wait_ms:
      rr_pending: 5000
`,
      read: (config) => config.workflows.requestRouter.checkWaitMs,
      want: { rr_pending: 5_000, rr_routing: 120_000 },
    },
    {
      name: 'When `linear_implementer` sets a state then should read it',
      workflowKey: 'linear_implementer',
      yaml: `
    check_wait_ms:
      li_waiting_pr: 900000
`,
      read: (config) => config.workflows.linearImplementer.checkWaitMs,
      want: {
        li_pending: 60_000,
        li_implementing: 120_000,
        li_verifying: 120_000,
        li_waiting_pr: 900_000,
      },
    },
    {
      // 0 is a cadence, not an omission: the state is revisited on the next tick.
      name: 'When `fix_implementer` sets a wait of `0` then should revisit on every tick',
      workflowKey: 'fix_implementer',
      yaml: `
    check_wait_ms:
      fi_verifying: 0
`,
      read: (config) => config.workflows.fixImplementer.checkWaitMs,
      want: {
        fi_pending: 60_000,
        fi_implementing: 120_000,
        fi_verifying: 0,
        fi_waiting_pr: 3_600_000,
      },
    },
    {
      name: 'When `pr_maintainer` sets every state then should read them all',
      workflowKey: 'pr_maintainer',
      yaml: `
    check_wait_ms:
      prm_pending: 30000
      prm_working: 60000
      prm_waiting: 600000
`,
      read: (config) => config.workflows.prMaintainer.checkWaitMs,
      want: { prm_pending: 30_000, prm_working: 60_000, prm_waiting: 600_000 },
    },
    {
      name: 'When `log_reviewer` sets a state then should read it',
      workflowKey: 'log_reviewer',
      yaml: `
    check_wait_ms:
      lr_working: 240000
`,
      read: (config) => config.workflows.logReviewer.checkWaitMs,
      want: { lr_pending: 60_000, lr_working: 240_000 },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const config = loadWorkflowConfig(testCase.workflowKey, testCase.yaml);

      assert.deepEqual(testCase.read(config), testCase.want);
    });
  }
});

describe('Workflow check wait cadence the loader refuses', () => {
  const cases: Array<{ name: string; workflowKey: string; yaml: string; wantError: RegExp }> = [
    {
      name: 'When the cadence is not a map then should return error',
      workflowKey: 'request_router',
      yaml: `
    check_wait_ms: 60000
`,
      wantError: /workflows\.request_router\.check_wait_ms must be an object/,
    },
    {
      name: 'When a state is not periodically checked then should name the accepted states',
      workflowKey: 'request_router',
      yaml: `
    check_wait_ms:
      rr_resolved: 60000
`,
      wantError:
        /workflows\.request_router\.check_wait_ms\.rr_resolved is not a periodically checked state; expected one of rr_pending, rr_routing/,
    },
    {
      name: 'When a wait is not a number then should return error',
      workflowKey: 'pr_maintainer',
      yaml: `
    check_wait_ms:
      prm_waiting: "5m"
`,
      wantError:
        /workflows\.pr_maintainer\.check_wait_ms\.prm_waiting must be a non-negative number of milliseconds/,
    },
    {
      name: 'When a wait is negative then should return error',
      workflowKey: 'log_reviewer',
      yaml: `
    check_wait_ms:
      lr_pending: -1
`,
      wantError:
        /workflows\.log_reviewer\.check_wait_ms\.lr_pending must be a non-negative number of milliseconds/,
    },
    {
      name: 'When a wait is not finite then should return error',
      workflowKey: 'fix_implementer',
      yaml: `
    check_wait_ms:
      fi_pending: .inf
`,
      wantError:
        /workflows\.fix_implementer\.check_wait_ms\.fi_pending must be a non-negative number of milliseconds/,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.throws(
        () => loadWorkflowConfig(testCase.workflowKey, testCase.yaml),
        testCase.wantError,
      );
    });
  }
});

describe('Worker config', () => {
  test('When the runner is `freestyle` then should read its provider settings', () => {
    const config = loadYamlConfig(`
  runner: "freestyle"
  freestyle_api_key_env: "FREESTYLE_TOKEN"
  freestyle_api_url_env: "FREESTYLE_ENDPOINT"
  default:
    image: "snapshot-worker"
`);

    assert.equal(config.worker.runner, 'freestyle');
    assert.equal(config.worker.freestyleApiKeyEnv, 'FREESTYLE_TOKEN');
    assert.equal(config.worker.freestyleApiUrlEnv, 'FREESTYLE_ENDPOINT');
  });

  test('When the reaper settings are overridden then should read them', () => {
    // Appended as indented children of the minimal config's existing worker map.
    const config = loadYamlConfig(`
  orchestrator_id: "jardinero-staging"
  sandbox_pause_retention_ms: 600000
  sandbox_reaper_interval_min: 2
`);

    assert.equal(config.worker.orchestratorId, 'jardinero-staging');
    assert.equal(config.worker.sandboxPauseRetentionMs, 600_000);
    assert.equal(config.worker.sandboxReaperIntervalMin, 2);
  });

  test('When the operational knobs are overridden then should read them', () => {
    const config = loadYamlConfig(`
  session_close_timeout_ms: 45000
  max_sandbox_ready_attempts: 4
  sandbox_ready_backoff_base_ms: 500
  sandbox_ready_backoff_jitter_ms: 250
`);

    assert.equal(config.worker.sessionCloseTimeoutMs, 45_000);
    assert.equal(config.worker.maxSandboxReadyAttempts, 4);
    assert.equal(config.worker.sandboxReadyBackoffBaseMs, 500);
    assert.equal(config.worker.sandboxReadyBackoffJitterMs, 250);
  });
});

describe('Worker seat effort', () => {
  const cases = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

  for (const effort of cases) {
    test(`When the effort is \`${effort}\` then should read it`, () => {
      const config = loadYamlConfig(`
  implementation_effort: "${effort}"
`);

      assert.equal(config.worker.implementationEffort, effort);
    });
  }
});

describe('Worker config the loader refuses', () => {
  const cases: Array<{ name: string; yaml: string; wantError: RegExp }> = [
    {
      name: 'When the runner is unknown then should return error',
      yaml: '  runner: "unknown"',
      wantError: /Expected "mock", "tenki", or "freestyle"/,
    },
    {
      name: 'When the Freestyle runner has no image then should return error',
      yaml: '  runner: "freestyle"',
      wantError: /worker\.default\.image is required when worker\.runner is "freestyle"/,
    },
    {
      name: 'When `session_close_timeout_ms` is a string then should return error',
      yaml: '  session_close_timeout_ms: "30000"',
      wantError: /worker\.session_close_timeout_ms must be a finite number/,
    },
    {
      name: 'When `max_sandbox_ready_attempts` is zero then should return error',
      yaml: '  max_sandbox_ready_attempts: 0',
      wantError: /worker\.max_sandbox_ready_attempts must be greater than 0/,
    },
    {
      name: 'When `max_sandbox_ready_attempts` is fractional then should return error',
      yaml: '  max_sandbox_ready_attempts: 1.5',
      wantError: /worker\.max_sandbox_ready_attempts must be a whole number/,
    },
    {
      name: 'When `sandbox_ready_backoff_base_ms` is zero then should return error',
      yaml: '  sandbox_ready_backoff_base_ms: 0',
      wantError: /worker\.sandbox_ready_backoff_base_ms must be greater than 0/,
    },
    {
      name: 'When `sandbox_ready_backoff_jitter_ms` is negative then should return error',
      yaml: '  sandbox_ready_backoff_jitter_ms: -1',
      wantError: /worker\.sandbox_ready_backoff_jitter_ms must not be negative/,
    },
    {
      name: 'When `sandbox_pause_retention_ms` is zero then should return error',
      yaml: '  sandbox_pause_retention_ms: 0',
      wantError: /worker\.sandbox_pause_retention_ms must be greater than 0/,
    },
    {
      // 0 disables the reaper; a negative value is a config mistake, so fail loud rather
      // than silently disable leak cleanup.
      name: 'When `sandbox_reaper_interval_min` is negative then should return error',
      yaml: '  sandbox_reaper_interval_min: -1',
      wantError: /worker\.sandbox_reaper_interval_min must not be negative/,
    },
    {
      name: 'When the effort is not a level then should return error',
      yaml: '  implementation_effort: "turbo"',
      wantError:
        /worker\.implementation_effort "turbo"\. Expected "low", "medium", "high", "xhigh", or "max"/,
    },
    {
      name: 'When the effort is `ultra` then should return error',
      yaml: '  implementation_effort: "ultra"',
      wantError: /Unsupported worker\.implementation_effort "ultra"/,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.throws(
        () =>
          loadYamlConfig(`
${testCase.yaml}
`),
        testCase.wantError,
      );
    });
  }
});

describe('Worker models and resources the loader refuses', () => {
  const cases: Array<{ name: string; yaml: string; wantError: RegExp }> = [
    {
      name: 'When a repo references an unknown generation then should return error',
      yaml: `
worker:
  default: { image: "d:t" }
  repos:
    acme/x:
      image: "x:t"
      model: { generation: "gpt-9.9", max_effort: "high" }
`,
      wantError: /unknown model generation "gpt-9.9"/,
    },
    {
      name: 'When a generation defines no implementation model then should return error',
      yaml: `
worker:
  model_generations:
    gpt-7.0:
      triage: "gpt-7.0-terra"
`,
      wantError: /must define an "implementation" model/,
    },
    {
      name: 'When the max effort is not a level then should return error',
      yaml: `
worker:
  default:
    image: "d:t"
    model: { generation: "gpt-5.5", max_effort: "turbo" }
`,
      wantError: /max_effort must be one of/,
    },
    {
      name: 'When a repo names memory without cpu cores then should return error',
      yaml: `
worker:
  repos:
    acme/alpha:
      resources: { memory_mb: 32768 }
`,
      wantError: /worker\.repos\.acme\/alpha\.resources\.cpu_cores must be a positive integer/,
    },
    {
      name: 'When a repo names cpu cores without memory then should return error',
      yaml: `
worker:
  repos:
    acme/alpha:
      resources: { cpu_cores: 16 }
`,
      wantError: /worker\.repos\.acme\/alpha\.resources\.memory_mb must be a positive integer/,
    },
    {
      name: 'When a repo asks for no cpu core then should return error',
      yaml: `
worker:
  repos:
    acme/alpha:
      resources: { cpu_cores: 0, memory_mb: 8192 }
`,
      wantError: /worker\.repos\.acme\/alpha\.resources\.cpu_cores must be a positive integer/,
    },
    {
      name: 'When the default memory is fractional then should return error',
      yaml: `
worker:
  default:
    image: "d:t"
    resources: { cpu_cores: 16, memory_mb: 8192.5 }
`,
      wantError: /worker\.default\.resources\.memory_mb must be a positive integer/,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const root = mkdtempSync(path.join(tmpdir(), 'jardinero-config-'));
      try {
        writeFileSync(path.join(root, 'config.yaml'), testCase.yaml);
        assert.throws(() => loadConfig('config.yaml', root), testCase.wantError);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe('Discord config', () => {
  test('When Discord is configured then should read its channels and roles', () => {
    const config = loadYamlConfig(`
discord:
  enabled: true
  allowed_role_ids:
    - " role-1 "
  repo_channels:
    "acme/orchestrator": "channel-1"
  default_channel_id: "channel-fallback"
  alerts_channel_id: "channel-alerts"
`);

    assert.deepEqual(config.discord, {
      enabled: true,
      applicationIdEnv: 'DISCORD_APPLICATION_ID',
      publicKeyEnv: 'DISCORD_PUBLIC_KEY',
      botTokenEnv: 'DISCORD_BOT_TOKEN',
      allowedRoleIds: ['role-1'],
      repoChannels: { 'acme/orchestrator': 'channel-1' },
      defaultChannelId: 'channel-fallback',
      alertsChannelId: 'channel-alerts',
    });
  });
});

describe('Discord config the loader refuses', () => {
  const cases: Array<{ name: string; yaml: string; wantError: RegExp }> = [
    {
      name: 'When a channel key is not an `owner/repo` slug then should return error',
      yaml: `
discord:
  repo_channels:
    jardinero: "channel-1"
`,
      wantError: /discord\.repo_channels\.jardinero must be an "owner\/repo" slug/,
    },
    {
      name: 'When a repository maps to a blank channel then should return error',
      yaml: `
discord:
  repo_channels:
    "acme/orchestrator": "  "
`,
      wantError: /discord\.repo_channels\.acme\/orchestrator must name a channel id/,
    },
    {
      name: 'When the allowed role ids are not a list then should return error',
      yaml: `
discord:
  allowed_role_ids: 12345
`,
      wantError: /discord\.allowed_role_ids must be a list of non-empty strings/,
    },
    {
      name: 'When an allowed role id is blank then should return error',
      yaml: `
discord:
  allowed_role_ids:
    - "  "
`,
      wantError: /discord\.allowed_role_ids must be a list of non-empty strings/,
    },
    {
      name: 'When Discord is enabled with no allowed role then should return error',
      yaml: `
discord:
  enabled: true
  default_channel_id: "channel-1"
`,
      wantError: /discord\.allowed_role_ids must list at least one role id/,
    },
    {
      name: 'When Discord is enabled with nowhere to write then should return error',
      yaml: `
discord:
  enabled: true
  allowed_role_ids:
    - "role-1"
`,
      wantError: /discord requires discord\.repo_channels or discord\.default_channel_id/,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.throws(() => loadYamlConfig(testCase.yaml), testCase.wantError);
    });
  }
});

describe('People config', () => {
  test('When people are configured then should read every identity they give', () => {
    const config = loadYamlConfig(`
people:
  - discord_user_id: " 1001 "
    discord_username: "octo"
    github_login: "octocat"
    linear_user_id: "linear-1"
  - discord_user_id: "2002"
    discord_username: "hubot"
`);

    assert.deepEqual(config.people, [
      {
        discordUserId: '1001',
        discordUsername: 'octo',
        githubLogin: 'octocat',
        linearUserId: 'linear-1',
      },
      { discordUserId: '2002', discordUsername: 'hubot' },
    ]);
  });
});

describe('People config the loader refuses', () => {
  const cases: Array<{ name: string; yaml: string; wantError: RegExp }> = [
    {
      name: 'When `people` is not a list then should return error',
      yaml: `
people:
  octo: "1001"
`,
      wantError: /people must be a list/,
    },
    {
      name: 'When a person is not an object then should return error',
      yaml: `
people:
  - "octo"
`,
      wantError: /people\[0\] must be an object/,
    },
    {
      name: 'When a person carries no discord user id then should return error',
      yaml: `
people:
  - discord_username: "octo"
`,
      wantError: /people\[0\]\.discord_user_id must be a non-empty string/,
    },
    {
      name: 'When a person carries no discord username then should return error',
      yaml: `
people:
  - discord_user_id: "1001"
`,
      wantError: /people\[0\]\.discord_username must be a non-empty string/,
    },
    {
      name: 'When a person carries a blank github login then should return error',
      yaml: `
people:
  - discord_user_id: "1001"
    discord_username: "octo"
    github_login: "  "
`,
      wantError: /people\[0\]\.github_login must be a non-empty string/,
    },
    {
      name: 'When a person carries a blank linear user id then should return error',
      yaml: `
people:
  - discord_user_id: "1001"
    discord_username: "octo"
    linear_user_id: "  "
`,
      wantError: /people\[0\]\.linear_user_id must be a non-empty string/,
    },
    {
      name: 'When two people share a discord user id then should return error',
      yaml: `
people:
  - discord_user_id: "1001"
    discord_username: "octo"
  - discord_user_id: "1001"
    discord_username: "hubot"
`,
      wantError: /people\[1\]\.discord_user_id "1001" is already people\[0\]/,
    },
    {
      name: 'When two people share a discord username then should return error',
      yaml: `
people:
  - discord_user_id: "1001"
    discord_username: "octo"
  - discord_user_id: "2002"
    discord_username: "octo"
`,
      wantError: /people\[1\]\.discord_username "octo" is already people\[0\]/,
    },
    {
      name: 'When two people share a github login then should return error',
      yaml: `
people:
  - discord_user_id: "1001"
    discord_username: "octo"
    github_login: "octocat"
  - discord_user_id: "2002"
    discord_username: "hubot"
    github_login: "octocat"
`,
      wantError: /people\[1\]\.github_login "octocat" is already people\[0\]/,
    },
    {
      // The login is looked up case-insensitively, so two casings are one claim.
      name: 'When two people share a github login in another case then should return error',
      yaml: `
people:
  - discord_user_id: "1001"
    discord_username: "octo"
    github_login: "octocat"
  - discord_user_id: "2002"
    discord_username: "hubot"
    github_login: "OctoCat"
`,
      wantError: /people\[1\]\.github_login "OctoCat" is already people\[0\]/,
    },
    {
      name: 'When two people share a linear user id then should return error',
      yaml: `
people:
  - discord_user_id: "1001"
    discord_username: "octo"
    linear_user_id: "linear-1"
  - discord_user_id: "2002"
    discord_username: "hubot"
    linear_user_id: "linear-1"
`,
      wantError: /people\[1\]\.linear_user_id "linear-1" is already people\[0\]/,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.throws(() => loadYamlConfig(testCase.yaml), testCase.wantError);
    });
  }
});

describe('resolveWorkerImage', () => {
  test('When a repo overrides its image then should return the override and otherwise the default', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jardinero-config-'));
    try {
      writeFileSync(
        path.join(root, 'config.yaml'),
        `
worker:
  default:
    image: "default/image:tag"
  repos:
    acme/alpha:
      image: "alpha/image:tag"
`,
      );
      const config = loadConfig('config.yaml', root);

      assert.equal(resolveWorkerImage(config, 'acme/alpha'), 'alpha/image:tag');
      assert.equal(resolveWorkerImage(config, 'acme/ALPHA'), 'alpha/image:tag');
      assert.equal(resolveWorkerImage(config, 'acme/beta'), 'default/image:tag');
      assert.equal(resolveWorkerImage(config, undefined), 'default/image:tag');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveSeatModel', () => {
  test('When a repo overrides its generation then should inherit the rest', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jardinero-config-'));
    try {
      writeFileSync(
        path.join(root, 'config.yaml'),
        `
worker:
  default:
    image: "default/image:tag"
    model: { generation: "gpt-5.5", max_effort: "xhigh" }
  repos:
    acme/alpha:
      image: "alpha/image:tag"
      model: { generation: "gpt-5.6", max_effort: "max" }
    acme/beta:
      image: "beta/image:tag"
      model: { generation: "gpt-5.5" }
    acme/gamma:
      image: "gamma/image:tag"
`,
      );
      const config = loadConfig('config.yaml', root);

      // alpha pins gpt-5.6 with a max cap; seats resolve to the generation's tiers.
      assert.equal(resolveWorkerGeneration(config, 'acme/alpha'), 'gpt-5.6');
      assert.equal(resolveWorkerMaxEffort(config, 'acme/alpha'), 'max');
      assert.equal(resolveSeatModel(config, 'acme/alpha', 'implementation'), 'gpt-5.6-sol');
      assert.equal(resolveSeatModel(config, 'acme/alpha', 'triage'), 'gpt-5.6-terra');
      // A seat with no generation entry falls back to the implementation tier.
      assert.equal(resolveSeatModel(config, 'acme/alpha', 'orchestrator'), 'gpt-5.6-sol');
      // beta omits max_effort, so it inherits the default cap.
      assert.equal(resolveWorkerGeneration(config, 'acme/beta'), 'gpt-5.5');
      assert.equal(resolveWorkerMaxEffort(config, 'acme/beta'), 'xhigh');
      // gpt-5.5 has no triage tier, so triage falls back to implementation.
      assert.equal(resolveSeatModel(config, 'acme/beta', 'triage'), 'gpt-5.5');
      // gamma has no model block, so it inherits the default generation and cap.
      assert.equal(resolveWorkerGeneration(config, 'acme/gamma'), 'gpt-5.5');
      assert.equal(resolveWorkerMaxEffort(config, 'acme/gamma'), 'xhigh');
      // An unmapped repo uses the default generation.
      assert.equal(resolveWorkerGeneration(config, 'acme/unknown'), 'gpt-5.5');
      assert.equal(resolveSeatModel(config, undefined, 'implementation'), 'gpt-5.5');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('When a generation defines a seat override then should use it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jardinero-config-'));
    try {
      writeFileSync(
        path.join(root, 'config.yaml'),
        `
worker:
  default:
    image: "default/image:tag"
    model: { generation: "gpt-5.6", max_effort: "max" }
  model_generations:
    gpt-5.6:
      implementation: "gpt-5.6-sol"
      triage: "gpt-5.6-terra"
      verify: "gpt-5.5"
`,
      );
      const config = loadConfig('config.yaml', root);

      // Seating one role on another generation's model is why seat overrides exist.
      assert.equal(resolveSeatModel(config, undefined, 'verify'), 'gpt-5.5');
      assert.equal(resolveSeatModel(config, undefined, 'triage'), 'gpt-5.6-terra');
      assert.equal(resolveSeatModel(config, undefined, 'implementation'), 'gpt-5.6-sol');
      assert.equal(resolveSeatModel(config, undefined, 'orchestrator'), 'gpt-5.6-sol');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('modelGenerationsAt', () => {
  test('When a generation override is partial then should merge it into the built-in seats', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jardinero-config-'));
    try {
      writeFileSync(
        path.join(root, 'config.yaml'),
        `
worker:
  default:
    image: "default/image:tag"
    model: { generation: "gpt-5.6", max_effort: "max" }
  model_generations:
    gpt-5.6:
      implementation: "gpt-5.6-custom"
`,
      );
      const config = loadConfig('config.yaml', root);

      assert.equal(resolveSeatModel(config, undefined, 'implementation'), 'gpt-5.6-custom');
      assert.equal(resolveSeatModel(config, undefined, 'triage'), 'gpt-5.6-terra');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveWorkerResources', () => {
  test('When a repo overrides its resources then should replace the default block', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jardinero-config-'));
    try {
      writeFileSync(
        path.join(root, 'config.yaml'),
        `
worker:
  default:
    image: "default/image:tag"
    resources: { cpu_cores: 6, memory_mb: 12288 }
  repos:
    acme/alpha:
      image: "alpha/image:tag"
      resources: { cpu_cores: 16, memory_mb: 32768 }
    acme/gamma:
      image: "gamma/image:tag"
`,
      );
      const config = loadConfig('config.yaml', root);

      // alpha overrides the default block.
      assert.deepEqual(resolveWorkerResources(config, 'acme/alpha'), {
        cpuCores: 16,
        memoryMb: 32768,
      });
      // Matching is case-insensitive like image/model resolution.
      assert.deepEqual(resolveWorkerResources(config, 'acme/ALPHA'), {
        cpuCores: 16,
        memoryMb: 32768,
      });
      // gamma has no resources block, so it inherits the default block as a unit.
      assert.deepEqual(resolveWorkerResources(config, 'acme/gamma'), {
        cpuCores: 6,
        memoryMb: 12288,
      });
      // An unmapped repo also inherits the default block.
      assert.deepEqual(resolveWorkerResources(config, 'acme/unknown'), {
        cpuCores: 6,
        memoryMb: 12288,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('When no resources are configured then should return undefined', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jardinero-config-'));
    try {
      writeFileSync(path.join(root, 'config.yaml'), 'worker:\n  default:\n    image: "d:t"\n');
      const config = loadConfig('config.yaml', root);

      assert.equal(resolveWorkerResources(config, 'acme/x'), undefined);
      assert.equal(resolveWorkerResources(config, undefined), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveWorkerSecretEnvs', () => {
  test('When a repo lists secret envs then should return them trimmed', () => {
    const config = loadYamlConfig(`
  repos:
    acme/alpha:
      secret_envs: [" WEBAPP_DEV_AGE_KEY ", "OTHER_KEY"]
    acme/gamma:
      image: "gamma/image:tag"
`);

    assert.deepEqual(resolveWorkerSecretEnvs(config, 'acme/alpha'), [
      'WEBAPP_DEV_AGE_KEY',
      'OTHER_KEY',
    ]);
    assert.deepEqual(resolveWorkerSecretEnvs(config, 'acme/ALPHA'), [
      'WEBAPP_DEV_AGE_KEY',
      'OTHER_KEY',
    ]);
    // A repo without the key, and an unmapped repo, get nothing: there is no default.
    assert.deepEqual(resolveWorkerSecretEnvs(config, 'acme/gamma'), []);
    assert.deepEqual(resolveWorkerSecretEnvs(config, 'acme/unknown'), []);
    assert.deepEqual(resolveWorkerSecretEnvs(config, undefined), []);
  });

  const rejectionCases = [
    {
      name: 'When secret envs is not a list then should return error',
      yaml: '  repos:\n    acme/alpha:\n      secret_envs: "KEY"\n',
      message: /worker\.repos\.acme\/alpha\.secret_envs must be an array of env var names/,
    },
    {
      name: 'When a secret env name is blank then should return error',
      yaml: '  repos:\n    acme/alpha:\n      secret_envs: ["  "]\n',
      message: /worker\.repos\.acme\/alpha\.secret_envs\[0\] must be a non-empty env var name/,
    },
    {
      name: 'When a secret env name is not a string then should return error',
      yaml: '  repos:\n    acme/alpha:\n      secret_envs: [7]\n',
      message: /worker\.repos\.acme\/alpha\.secret_envs\[0\] must be a non-empty env var name/,
    },
  ] as const;

  for (const c of rejectionCases) {
    test(c.name, () => {
      assert.throws(() => loadYamlConfig(c.yaml), c.message);
    });
  }
});

describe('clampEffort', () => {
  const clampCases = [
    {
      name: 'When base is below cap then should keep base',
      base: 'medium',
      cap: 'xhigh',
      want: 'medium',
    },
    {
      name: 'When base is above cap then should clamp to cap',
      base: 'max',
      cap: 'xhigh',
      want: 'xhigh',
    },
    {
      name: 'When base equals cap then should keep base',
      base: 'xhigh',
      cap: 'xhigh',
      want: 'xhigh',
    },
  ] as const;

  for (const c of clampCases) {
    test(c.name, () => {
      assert.equal(clampEffort(c.base, c.cap), c.want);
    });
  }
});

describe('workflowConcurrencies', () => {
  test('When the workflows are configured then should answer every cap', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jardinero-config-'));
    try {
      writeFileSync(
        path.join(root, 'config.yaml'),
        `
workflows:
  pr_maintainer:
    max_concurrent_runs: 3
  log_reviewer:
    enabled: false
    max_concurrent_runs: 4
  fix_implementer:
    max_concurrent_runs: 5
  linear_implementer:
    max_concurrent_runs: 6
  request_router:
    max_concurrent_runs: 7
`,
      );
      const config = loadConfig('config.yaml', root);

      assert.deepEqual(workflowConcurrencies(config), {
        pr_maintainer: 3,
        log_reviewer: 4,
        fix_implementer: 5,
        linear_implementer: 6,
        request_router: 7,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('discordChannelForRepository', () => {
  const cases: Array<{ name: string; repositoryFullName: string; wantChannelId?: string }> = [
    {
      name: 'When the repository has a channel then should answer it',
      repositoryFullName: 'acme/orchestrator',
      wantChannelId: 'channel-1',
    },
    {
      name: 'When the repository is written in another case then should answer the same channel',
      repositoryFullName: 'acme/ORCHESTRATOR',
      wantChannelId: 'channel-1',
    },
    {
      name: 'When the repository has no channel then should answer the default',
      repositoryFullName: 'acme/webapp',
      wantChannelId: 'channel-fallback',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const config = loadDiscordConfig();

      assert.equal(
        discordChannelForRepository(config, testCase.repositoryFullName),
        testCase.wantChannelId,
      );
    });
  }

  test('When nothing maps the repository and there is no default then should answer nothing', () => {
    const config = loadYamlConfig(`
discord:
  repo_channels:
    "acme/orchestrator": "channel-1"
`);

    assert.equal(discordChannelForRepository(config, 'acme/webapp'), undefined);
  });
});

describe('repositoriesForDiscordChannel', () => {
  const cases: Array<{ name: string; channelId: string; wantRepositoryFullNames: string[] }> = [
    {
      name: 'When one repository reports to the channel then should answer it',
      channelId: 'channel-1',
      wantRepositoryFullNames: ['acme/orchestrator'],
    },
    {
      name: 'When several report to the channel then should answer them in the order configured',
      channelId: 'channel-shared',
      wantRepositoryFullNames: ['acme/fleet', 'acme/energy'],
    },
    {
      // The default channel is where work with no channel of its own is announced, and
      // says nothing about which repository a command run there is about.
      name: 'When the channel is the default then should answer none',
      channelId: 'channel-fallback',
      wantRepositoryFullNames: [],
    },
    {
      name: 'When the channel is not mapped then should answer none',
      channelId: 'channel-9',
      wantRepositoryFullNames: [],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const config = loadDiscordConfig();

      assert.deepEqual(
        repositoriesForDiscordChannel(config, testCase.channelId),
        testCase.wantRepositoryFullNames,
      );
    });
  }
});

describe('personForDiscordUserId', () => {
  const cases: Array<{ name: string; discordUserId: string; wantUsername?: string }> = [
    {
      name: 'When the id is configured then should answer that person',
      discordUserId: '1001',
      wantUsername: 'octo',
    },
    {
      name: 'When the id is padded then should still answer that person',
      discordUserId: ' 1001 ',
      wantUsername: 'octo',
    },
    {
      name: 'When the id is not configured then should answer nobody',
      discordUserId: '9009',
      wantUsername: undefined,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const person = personForDiscordUserId(loadPeopleConfig(), testCase.discordUserId);

      assert.equal(person?.discordUsername, testCase.wantUsername);
    });
  }
});

describe('personForGithubLogin', () => {
  const cases: Array<{ name: string; githubLogin: string; wantUsername?: string }> = [
    {
      name: 'When the login is configured then should answer that person',
      githubLogin: 'octocat',
      wantUsername: 'octo',
    },
    {
      // GitHub logins are case-insensitive, and a comment carries whatever casing its
      // author typed.
      name: 'When the login differs in case then should answer that person',
      githubLogin: 'OctoCat',
      wantUsername: 'octo',
    },
    {
      name: 'When the person has no github login then should answer nobody',
      githubLogin: 'hubot',
      wantUsername: undefined,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const person = personForGithubLogin(loadPeopleConfig(), testCase.githubLogin);

      assert.equal(person?.discordUsername, testCase.wantUsername);
    });
  }
});

describe('personForLinearUserId', () => {
  const cases: Array<{ name: string; linearUserId: string; wantUsername?: string }> = [
    {
      name: 'When the linear user id is configured then should answer that person',
      linearUserId: 'linear-1',
      wantUsername: 'octo',
    },
    {
      name: 'When the person has no linear user id then should answer nobody',
      linearUserId: 'linear-9',
      wantUsername: undefined,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const person = personForLinearUserId(loadPeopleConfig(), testCase.linearUserId);

      assert.equal(person?.discordUsername, testCase.wantUsername);
    });
  }
});

describe('configuredRepositoryNames', () => {
  const cases: Array<{ name: string; arrange(config: AppConfig): void; want: string[] }> = [
    {
      name: 'When a scan target names a repository then should answer it',
      arrange: (config) => {
        config.workflows.logReviewer.repos = [{ repo: 'acme/web.app', clusters: [], services: [] }];
        config.workflows.linearImplementer.teamRepos = {};
      },
      want: ['acme/web.app'],
    },
    {
      name: 'When a team maps to a repository then should answer it',
      arrange: (config) => {
        config.workflows.logReviewer.repos = [];
        config.workflows.linearImplementer.teamRepos = { JAR: 'acme/orchestrator' };
      },
      want: ['acme/orchestrator'],
    },
    {
      name: 'When a team has project and additional repos then should answer every repository it can reach',
      arrange: (config) => {
        config.workflows.logReviewer.repos = [];
        config.workflows.linearImplementer.teamRepos = {
          CLO: {
            default: 'acme/web.app',
            projects: { Billing: 'acme/webapp' },
            repos: ['acme/cloud'],
          },
        };
      },
      want: ['acme/cloud', 'acme/web.app', 'acme/webapp'],
    },
    {
      name: 'When a Discord channel maps to a repository then should answer it',
      arrange: (config) => {
        config.workflows.logReviewer.repos = [];
        config.workflows.linearImplementer.teamRepos = {};
        config.discord.repoChannels = { 'acme/orchestrator': 'channel-1' };
      },
      want: ['acme/orchestrator'],
    },
    {
      name: 'When a repository is both a target and a route then should answer it once',
      arrange: (config) => {
        config.workflows.logReviewer.repos = [
          { repo: 'acme/orchestrator', clusters: [], services: [] },
        ];
        config.workflows.linearImplementer.teamRepos = { JAR: 'acme/orchestrator' };
        config.discord.repoChannels = { 'acme/orchestrator': 'channel-1' };
      },
      want: ['acme/orchestrator'],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const config = loadConfig();
      testCase.arrange(config);

      assert.deepEqual(configuredRepositoryNames(config), testCase.want);
    });
  }
});

describe('validateRepoConfig', () => {
  const CHANNEL = 'channel-1';
  const IMAGE = { image: 'ghcr.io/acme/orchestrator:latest' };
  const cases: Array<{
    name: string;
    arrange(config: AppConfig): void;
    want: Array<{ repositoryFullName: string; missing: number }>;
  }> = [
    {
      name: 'When a repository has a channel and an image then should report no gap',
      arrange: (config) => {
        config.discord.repoChannels = { 'acme/orchestrator': CHANNEL };
        config.worker.repos = { 'acme/orchestrator': IMAGE };
      },
      want: [],
    },
    {
      name: 'When a repository has no channel then should report that gap',
      arrange: (config) => {
        config.discord.repoChannels = {};
        config.worker.repos = { 'acme/orchestrator': IMAGE };
      },
      want: [{ repositoryFullName: 'acme/orchestrator', missing: 1 }],
    },
    {
      name: 'When a repository has no image then should report that gap',
      arrange: (config) => {
        config.discord.repoChannels = { 'acme/orchestrator': CHANNEL };
        config.worker.repos = {};
      },
      want: [{ repositoryFullName: 'acme/orchestrator', missing: 1 }],
    },
    {
      name: 'When a repository has neither then should report both gaps',
      arrange: (config) => {
        config.discord.repoChannels = {};
        config.worker.repos = {};
      },
      want: [{ repositoryFullName: 'acme/orchestrator', missing: 2 }],
    },
    {
      name: 'When they are written in another case then should report no gap',
      arrange: (config) => {
        config.discord.repoChannels = { 'acme/ORCHESTRATOR': CHANNEL };
        config.worker.repos = { 'acme/ORCHESTRATOR': IMAGE };
      },
      want: [],
    },
    {
      name: 'When a repository is reached through a project route then should look at it too',
      arrange: (config) => {
        config.workflows.linearImplementer.teamRepos = {
          JAR: {
            default: 'acme/orchestrator',
            projects: { Billing: 'acme/webapp' },
            repos: [],
          },
        };
        config.discord.repoChannels = { 'acme/orchestrator': CHANNEL };
        config.worker.repos = { 'acme/orchestrator': IMAGE };
      },
      want: [{ repositoryFullName: 'acme/webapp', missing: 2 }],
    },
    {
      name: 'When we work in no repository then should report nothing',
      arrange: (config) => {
        config.workflows.logReviewer.repos = [];
        config.workflows.linearImplementer.teamRepos = {};
        config.discord.repoChannels = {};
      },
      want: [],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const config = loadConfig();
      config.workflows.logReviewer.repos = [];
      config.workflows.linearImplementer.teamRepos = { JAR: 'acme/orchestrator' };
      testCase.arrange(config);

      assert.deepEqual(
        validateRepoConfig(config).map((gap) => ({
          repositoryFullName: gap.repositoryFullName,
          missing: gap.missing.length,
        })),
        testCase.want,
      );
    });
  }
});

describe('repositoryForLinearTeamKey', () => {
  const cases: Array<{ name: string; teamKey: string; wantRepository?: string }> = [
    {
      name: 'When a team maps to one repository then should answer it',
      teamKey: 'BAC',
      wantRepository: 'acme/ledger',
    },
    {
      // The prefix of an identifier is written however the person typed it.
      name: 'When the team is written in another case then should still answer its repository',
      teamKey: 'jar',
      wantRepository: 'acme/orchestrator',
    },
    {
      // A team that selects among repositories still has one its work lands in.
      name: 'When a team routes to several then should answer its default',
      teamKey: 'CLO',
      wantRepository: 'acme/web.app',
    },
    {
      name: 'When no team is named that then should answer nothing',
      teamKey: 'ZZZ',
      wantRepository: undefined,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const config = loadWorkflowConfig(
        'linear_implementer',
        `
    enabled: true
    team_repos:
      BAC: "acme/ledger"
      JAR:
        default: "acme/orchestrator"
        repos:
          - "acme/shared"
      CLO:
        default: "acme/web.app"
        repos:
          - "acme/cloud"
`,
      );

      assert.equal(repositoryForLinearTeamKey(config, testCase.teamKey), testCase.wantRepository);
    });
  }
});

describe('linearTeamKeysForRepository', () => {
  const cases: Array<{ name: string; repositoryFullName: string; wantTeamKeys: string[] }> = [
    {
      name: 'When a team maps to the repository as a string then should answer that team',
      repositoryFullName: 'acme/orchestrator',
      wantTeamKeys: ['JAR'],
    },
    {
      name: 'When the repository is written in another case then should still answer its team',
      repositoryFullName: 'acme/ORCHESTRATOR',
      wantTeamKeys: ['JAR'],
    },
    {
      name: 'When the repository is a team default then should answer that team',
      repositoryFullName: 'acme/web.app',
      wantTeamKeys: ['CLO'],
    },
    {
      name: 'When the repository is one a team may select then should answer that team',
      repositoryFullName: 'acme/cloud',
      wantTeamKeys: ['CLO'],
    },
    {
      name: 'When the repository is a project route then should answer that team',
      repositoryFullName: 'acme/webapp',
      wantTeamKeys: ['CLO'],
    },
    {
      // Two teams numbering one repository means no number can become an identifier.
      name: 'When two teams reach the repository then should answer both',
      repositoryFullName: 'acme/shared',
      wantTeamKeys: ['CLO', 'JAR'],
    },
    {
      name: 'When no team reaches the repository then should answer none',
      repositoryFullName: 'acme/ledger',
      wantTeamKeys: [],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const config = loadWorkflowConfig(
        'linear_implementer',
        `
    enabled: true
    team_repos:
      JAR:
        default: "acme/orchestrator"
        repos:
          - "acme/shared"
      CLO:
        default: "acme/web.app"
        projects:
          Billing: "acme/webapp"
        repos:
          - "acme/cloud"
          - "acme/shared"
`,
      );

      assert.deepEqual(
        linearTeamKeysForRepository(config, testCase.repositoryFullName).sort(),
        testCase.wantTeamKeys,
      );
    });
  }
});

function loadPeopleConfig(): ReturnType<typeof loadConfig> {
  return loadYamlConfig(`
people:
  - discord_user_id: "1001"
    discord_username: "octo"
    github_login: "octocat"
    linear_user_id: "linear-1"
  - discord_user_id: "2002"
    discord_username: "hubot"
`);
}

function loadDiscordConfig(): ReturnType<typeof loadConfig> {
  return loadYamlConfig(`
discord:
  repo_channels:
    "acme/orchestrator": "channel-1"
    "acme/fleet": "channel-shared"
    "acme/energy": "channel-shared"
  default_channel_id: "channel-fallback"
`);
}

function loadYamlConfig(yaml: string): ReturnType<typeof loadConfig> {
  const root = mkdtempSync(path.join(tmpdir(), 'jardinero-config-'));
  try {
    writeFileSync(path.join(root, 'config.yaml'), `${minimalConfigYaml()}\n${yaml}`);
    return loadConfig('config.yaml', root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function minimalConfigYaml(): string {
  return `
workflows:
  log_reviewer:
    enabled: false
    repos:
      - repo: "acme/test"
        services:
          - "api"
worker:
  workspace_path: "/home/tenki/workspace"
`;
}

// pr_maintainer shares the top-level workflows key with log_reviewer, so it cannot be

// fix_implementer shares the top-level workflows key with log_reviewer, so it cannot be

// linear_implementer shares the top-level workflows key with log_reviewer, so it cannot be

// A workflow block shares the top-level workflows key with every other workflow, so it
// cannot be appended like loadYamlConfig does; build a whole config around the block.
function loadWorkflowConfig(
  workflowKey: string,
  workflowYaml: string,
): ReturnType<typeof loadConfig> {
  const root = mkdtempSync(path.join(tmpdir(), 'jardinero-config-'));
  try {
    writeFileSync(
      path.join(root, 'config.yaml'),
      `
workflows:
  ${workflowKey}:
${workflowYaml}
worker:
  workspace_path: "/home/tenki/workspace"
`,
    );
    return loadConfig('config.yaml', root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
