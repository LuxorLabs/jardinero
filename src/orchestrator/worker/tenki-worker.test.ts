import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadConfig, type AppConfig } from '../../config.js';
import { JARDINERO_SANDBOX_APP } from '../../adapters/tenki/tenki-scope.js';
import type { SandboxSession } from '../../types.js';
import { TenkiSandboxProvider, TenkiWorkerRunner, loadTenkiSdk } from './tenki-worker.js';

describe('TenkiWorkerRunner', () => {
  test('When a run starts then should report the Tenki provider by name', async () => {
    const runner = new TenkiWorkerRunner(tenkiConfig(), {}, { loadSdk: async () => fakeSdk() });
    const context = {
      task: { workflow: 'pr_maintain', payload: {}, promptOverrides: {} },
    } as unknown as Parameters<TenkiWorkerRunner['run']>[0];

    await assert.rejects(
      () => runner.run(context),
      /Tenki runner is missing required environment variables: GITHUB_TOKEN$/,
    );
  });
});

describe('TenkiSandboxProvider.create', () => {
  const cases: Array<{
    name: string;
    env: NodeJS.ProcessEnv;
    wantScope: Record<string, unknown>;
  }> = [
    {
      name: 'When a workspace is configured then should scope the create options to it',
      env: { TENKI_WORKSPACE_ID: 'workspace-1' },
      wantScope: { workspaceId: 'workspace-1' },
    },
    {
      // Nothing configured and one reachable workspace is unambiguous, so the
      // create goes out unscoped and Tenki resolves it from the credential.
      name: 'When no workspace is configured then should leave the create options unscoped',
      env: {},
      wantScope: {},
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const created: Array<Record<string, unknown>> = [];
      const provider = new TenkiSandboxProvider(tenkiConfig(), testCase.env, {
        loadSdk: async () => fakeSdk(created),
      });

      const session = await provider.create({ name: 'agent-run' }, new AbortController().signal);

      assert.equal(session.id, 'session-1');
      assert.deepEqual(created[0], {
        name: 'agent-run',
        tags: [JARDINERO_SANDBOX_APP],
        ...testCase.wantScope,
      });
    });
  }

  test('When the credential reaches several workspaces then should refuse to create', async () => {
    const provider = new TenkiSandboxProvider(
      tenkiConfig(),
      {},
      {
        loadSdk: async () =>
          fakeSdk([], {
            workspaces: [
              { id: 'ws-1', name: 'alpha' },
              { id: 'ws-2', name: 'beta' },
            ],
          }),
      },
    );

    await assert.rejects(
      () => provider.create({}, new AbortController().signal),
      /Missing TENKI_WORKSPACE_ID; the Tenki credential reaches 2 workspaces/,
    );
  });

  test('When several runs share the provider then should resolve the workspace once', async () => {
    let whoAmICalls = 0;
    const provider = new TenkiSandboxProvider(
      tenkiConfig(),
      {},
      { loadSdk: async () => fakeSdk([], { onWhoAmI: () => (whoAmICalls += 1) }) },
    );

    await provider.create({}, new AbortController().signal);
    await provider.create({}, new AbortController().signal);

    assert.equal(whoAmICalls, 1);
  });

  test('When several runs share the provider then should build the client once', async () => {
    let sdkLoads = 0;
    const provider = new TenkiSandboxProvider(
      tenkiConfig(),
      {},
      {
        loadSdk: async () => {
          sdkLoads += 1;
          return fakeSdk();
        },
      },
    );

    await provider.create({}, new AbortController().signal);
    await provider.create({}, new AbortController().signal);

    assert.equal(sdkLoads, 1);
  });
});

describe('TenkiSandboxProvider.waitReady', () => {
  test('When the session is asked to become ready then should pass the abort signal through', async () => {
    const provider = new TenkiSandboxProvider(tenkiConfig(), {});
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const session = {
      id: 'session-1',
      waitReady: async (_timeout?: number, signal?: AbortSignal) => {
        seen.push(signal);
      },
    } as unknown as SandboxSession;

    await provider.waitReady(session, controller.signal);

    assert.deepEqual(seen, [controller.signal]);
  });
});

describe('TenkiSandboxProvider.terminate', () => {
  test('When a session is closed then should hand its id to the child-process close', async () => {
    const closed: string[] = [];
    const provider = new TenkiSandboxProvider(
      tenkiConfig(),
      { TENKI_API_KEY: 'key' },
      {
        terminateSession: async (sessionId) => {
          closed.push(sessionId);
        },
      },
    );

    await provider.terminate({ id: 'session-1' } as SandboxSession);

    assert.deepEqual(closed, ['session-1']);
  });
});

describe('loadTenkiSdk', () => {
  test('When the SDK is installed then should return it', async () => {
    const sdk = await loadTenkiSdk();

    assert.equal(typeof sdk.TenkiSandbox, 'function');
  });
});

function tenkiConfig(): AppConfig {
  const config = loadConfig();
  config.worker.runner = 'tenki';
  config.worker.default.image = 'registry/worker:1';
  return config;
}

// fakeSdk stands in for the SDK module: the sandbox client the provider builds,
// and the session its create answers with. The identity defaults to a single
// workspace, which is what an unscoped create needs to be unambiguous.
function fakeSdk(
  created: Array<Record<string, unknown>> = [],
  options: { workspaces?: Array<{ id: string; name: string }>; onWhoAmI?: () => void } = {},
) {
  const workspaces = options.workspaces ?? [{ id: 'ws-1', name: 'only' }];
  return {
    TenkiSandbox: class {
      async whoAmI() {
        options.onWhoAmI?.();
        return { workspaces };
      }
      async create(createOptions: Record<string, unknown>): Promise<SandboxSession> {
        created.push(createOptions);
        return { id: 'session-1' } as SandboxSession;
      }
    },
  } as unknown as Awaited<ReturnType<typeof loadTenkiSdk>>;
}
