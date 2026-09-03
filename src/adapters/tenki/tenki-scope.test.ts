import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadConfig } from '../../config.js';
import {
  buildTenkiClientOptions,
  resolveWorkspaceScope,
  type TenkiScopeClient,
} from './tenki-scope.js';

describe('resolveWorkspaceScope', () => {
  const cases: Array<{
    name: string;
    env: NodeJS.ProcessEnv;
    reaches: string[];
    wantScope?: { workspaceId: string };
    wantError?: RegExp;
    wantCalls: number;
  }> = [
    {
      // A configured workspace is the whole answer, so the credential is never asked.
      name: 'When a workspace is configured then should scope to it',
      env: { TENKI_WORKSPACE_ID: 'workspace-1' },
      reaches: ['one', 'two'],
      wantScope: { workspaceId: 'workspace-1' },
      wantCalls: 0,
    },
    {
      name: 'When one workspace is reachable then should name it on the request',
      env: {},
      reaches: ['only'],
      wantScope: { workspaceId: 'ws-0' },
      wantCalls: 1,
    },
    {
      name: 'When the configured workspace is blank then should fall back to the credential',
      env: { TENKI_WORKSPACE_ID: '   ' },
      reaches: ['only'],
      wantScope: { workspaceId: 'ws-0' },
      wantCalls: 1,
    },
    {
      name: 'When several workspaces are reachable then should refuse and name them',
      env: {},
      reaches: ['alpha', 'beta'],
      wantError:
        /Missing TENKI_WORKSPACE_ID; the Tenki credential reaches 2 workspaces: alpha \(ws-0\), beta \(ws-1\)\./,
      wantCalls: 1,
    },
    {
      name: 'When no workspace is reachable then should refuse',
      env: {},
      reaches: [],
      wantError: /Missing TENKI_WORKSPACE_ID; the Tenki credential reaches no workspace\./,
      wantCalls: 1,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const client = clientReaching(...testCase.reaches);
      const act = () => resolveWorkspaceScope(loadConfig(), testCase.env, client);

      if (testCase.wantError) {
        await assert.rejects(act, testCase.wantError);
      } else {
        assert.deepEqual(await act(), testCase.wantScope);
      }

      assert.equal(client.calls(), testCase.wantCalls);
    });
  }
});

describe('buildTenkiClientOptions', () => {
  const cases: Array<{ name: string; env: NodeJS.ProcessEnv; want: Record<string, unknown> }> = [
    {
      name: 'When the api key and url are set then should return both',
      env: { TENKI_API_KEY: 'key', TENKI_API_URL: 'https://api.tenki.test' },
      want: { authToken: 'key', baseUrl: 'https://api.tenki.test' },
    },
    { name: 'When the env is empty then should return no options', env: {}, want: {} },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.deepEqual(buildTenkiClientOptions(loadConfig(), testCase.env), testCase.want);
    });
  }
});

// A credential reaching the named workspaces, counting how often it was asked.
function clientReaching(...names: string[]): TenkiScopeClient & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    whoAmI: async () => {
      calls += 1;
      return { workspaces: names.map((name, index) => ({ id: `ws-${index}`, name })) };
    },
  };
}
