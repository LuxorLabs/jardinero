import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadConfig } from '../../config.js';
import { buildTenkiClientOptions, resolveWorkspaceScope } from './tenki-scope.js';

describe('resolveWorkspaceScope', () => {
  const cases: Array<{ name: string; env: NodeJS.ProcessEnv; want: Record<string, unknown> }> = [
    {
      name: 'When a workspace is configured then should scope to it',
      env: { TENKI_WORKSPACE_ID: 'workspace-1' },
      want: { workspaceId: 'workspace-1' },
    },
    {
      // The key has to be absent rather than present-and-undefined: the SDK sends
      // what it is handed, and Tenki rejects an explicit empty scope.
      name: 'When no workspace is configured then should return no scope',
      env: {},
      want: {},
    },
    {
      name: 'When the configured workspace is blank then should return no scope',
      env: { TENKI_WORKSPACE_ID: '   ' },
      want: {},
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.deepEqual(resolveWorkspaceScope(loadConfig(), testCase.env), testCase.want);
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
