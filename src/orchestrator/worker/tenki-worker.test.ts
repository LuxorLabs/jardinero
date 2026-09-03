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
    workspaces?: Array<{ id: string; name: string }>;
    creates?: number;
    wantScope?: Record<string, unknown>;
    wantError?: RegExp;
    wantWhoAmICalls: number;
    wantSdkLoads: number;
  }> = [
    {
      name: 'When a workspace is configured then should scope the create options to it',
      env: { TENKI_WORKSPACE_ID: 'workspace-1' },
      wantScope: { workspaceId: 'workspace-1' },
      wantWhoAmICalls: 0,
      wantSdkLoads: 1,
    },
    {
      // Nothing configured and one reachable workspace is unambiguous, so the
      // create names the one the credential reaches.
      name: 'When no workspace is configured then should scope to the one the credential reaches',
      env: {},
      wantScope: { workspaceId: 'ws-1' },
      wantWhoAmICalls: 1,
      wantSdkLoads: 1,
    },
    {
      name: 'When several runs share the provider then should resolve the workspace and client once',
      env: {},
      creates: 2,
      wantScope: { workspaceId: 'ws-1' },
      wantWhoAmICalls: 1,
      wantSdkLoads: 1,
    },
    {
      // Scope resolution refusing is the run refusing; a create that picked a
      // workspace on its own is what the guard exists to prevent.
      name: 'When the credential reaches several workspaces then should refuse to create',
      env: {},
      workspaces: [
        { id: 'ws-1', name: 'alpha' },
        { id: 'ws-2', name: 'beta' },
      ],
      wantError: /Missing TENKI_WORKSPACE_ID; the Tenki credential reaches 2 workspaces/,
      wantWhoAmICalls: 1,
      wantSdkLoads: 1,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const created: Array<Record<string, unknown>> = [];
      let whoAmICalls = 0;
      let sdkLoads = 0;
      const provider = new TenkiSandboxProvider(tenkiConfig(), testCase.env, {
        loadSdk: async () => {
          sdkLoads += 1;
          return fakeSdk(created, {
            workspaces: testCase.workspaces,
            onWhoAmI: () => (whoAmICalls += 1),
          });
        },
      });
      const creates = testCase.creates ?? 1;
      const act = async (): Promise<void> => {
        for (let attempt = 0; attempt < creates; attempt += 1) {
          const session = await provider.create(
            { name: 'agent-run' },
            new AbortController().signal,
          );
          assert.equal(session.id, 'session-1');
        }
      };

      if (testCase.wantError) {
        await assert.rejects(act, testCase.wantError);
      } else {
        await act();
      }

      assert.deepEqual(
        created,
        testCase.wantScope
          ? Array.from({ length: creates }, () => ({
              name: 'agent-run',
              tags: [JARDINERO_SANDBOX_APP],
              ...testCase.wantScope,
            }))
          : [],
      );
      assert.equal(whoAmICalls, testCase.wantWhoAmICalls);
      assert.equal(sdkLoads, testCase.wantSdkLoads);
    });
  }
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
