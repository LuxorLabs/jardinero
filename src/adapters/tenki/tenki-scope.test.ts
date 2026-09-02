import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadConfig } from '../../config.js';
import { buildTenkiClientOptions, resolveWorkspaceScope } from './tenki-scope.js';

describe('resolveWorkspaceScope', () => {
  function clientReaching(...names: string[]) {
    let calls = 0;
    return {
      calls: () => calls,
      whoAmI: async () => {
        calls += 1;
        return { workspaces: names.map((name, index) => ({ id: `ws-${index}`, name })) };
      },
    };
  }

  test('When a workspace is configured then should scope to it', async () => {
    const client = clientReaching('one', 'two');
    assert.deepEqual(
      await resolveWorkspaceScope(loadConfig(), { TENKI_WORKSPACE_ID: 'workspace-1' }, client),
      { workspaceId: 'workspace-1' },
    );
    // A configured workspace is the whole answer, so the credential is never asked.
    assert.equal(client.calls(), 0);
  });

  test('When one workspace is reachable then should leave the request unscoped', async () => {
    assert.deepEqual(await resolveWorkspaceScope(loadConfig(), {}, clientReaching('only')), {});
  });

  test('When the configured workspace is blank then should fall back to the credential', async () => {
    assert.deepEqual(
      await resolveWorkspaceScope(
        loadConfig(),
        { TENKI_WORKSPACE_ID: '   ' },
        clientReaching('only'),
      ),
      {},
    );
  });

  test('When several workspaces are reachable then should refuse and name them', async () => {
    await assert.rejects(
      () => resolveWorkspaceScope(loadConfig(), {}, clientReaching('alpha', 'beta')),
      (error: Error) => {
        assert.match(error.message, /Missing TENKI_WORKSPACE_ID/);
        assert.match(error.message, /reaches 2 workspaces/);
        assert.match(error.message, /alpha \(ws-0\), beta \(ws-1\)/);
        return true;
      },
    );
  });

  test('When no workspace is reachable then should refuse', async () => {
    await assert.rejects(
      () => resolveWorkspaceScope(loadConfig(), {}, clientReaching()),
      /reaches no workspace/,
    );
  });
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
