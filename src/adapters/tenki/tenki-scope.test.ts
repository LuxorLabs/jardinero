import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadConfig } from '../../config.js';
import {
  applyTenkiScope,
  buildTenkiClientOptions,
  resolveTenkiScope,
  type TenkiScopeClient,
} from './tenki-scope.js';

describe('resolveTenkiScope', () => {
  const ONE_PROJECT = [{ id: 'workspace-1', projects: [{ id: 'project-1', name: 'Default' }] }];

  const resolutionCases: Array<{
    name: string;
    env: NodeJS.ProcessEnv;
    workspaces?: Workspace[];
    want: { projectId: string; workspaceId?: string };
  }> = [
    {
      // A configured project is authoritative, so the client is never called; the
      // refusing client is what proves it.
      name: 'When the project id is configured then should use it without calling tenki',
      env: { TENKI_PROJECT_ID: 'project-1', TENKI_WORKSPACE_ID: 'workspace-1' },
      want: { projectId: 'project-1', workspaceId: 'workspace-1' },
    },
    {
      name: 'When only the project id is configured then should leave the workspace unset',
      env: { TENKI_PROJECT_ID: 'project-1' },
      want: { projectId: 'project-1', workspaceId: undefined },
    },
    {
      name: 'When the auth has exactly one project then should select it',
      env: {},
      workspaces: ONE_PROJECT,
      want: { projectId: 'project-1', workspaceId: 'workspace-1' },
    },
    {
      name: 'When a workspace is configured then should keep it over the discovered one',
      env: { TENKI_WORKSPACE_ID: 'workspace-override' },
      workspaces: ONE_PROJECT,
      want: { projectId: 'project-1', workspaceId: 'workspace-override' },
    },
  ];

  for (const testCase of resolutionCases) {
    test(testCase.name, async () => {
      const client = testCase.workspaces ? identityClient(testCase.workspaces) : refusingClient();

      const scope = await resolveTenkiScope(loadConfig(), testCase.env, client);

      assert.deepEqual(scope, testCase.want);
    });
  }

  // Without a configured project id the scope can only be inferred when the auth
  // leaves exactly one candidate; anything else has to fail loudly rather than pick.
  const rejectionCases: Array<{ name: string; workspaces: Workspace[]; wantError: RegExp }> = [
    {
      name: 'When the auth has several projects then should return error',
      workspaces: [
        {
          id: 'workspace-1',
          projects: [
            { id: 'project-1', name: 'One' },
            { id: 'project-2', name: 'Two' },
          ],
        },
      ],
      wantError: /Missing TENKI_PROJECT_ID; Tenki auth has 2 projects/,
    },
    {
      name: 'When the auth has no project then should return error',
      workspaces: [],
      wantError: /Missing TENKI_PROJECT_ID; Tenki auth returned no projects./,
    },
  ];

  for (const testCase of rejectionCases) {
    test(testCase.name, async () => {
      await assert.rejects(
        () => resolveTenkiScope(loadConfig(), {}, identityClient(testCase.workspaces)),
        testCase.wantError,
      );
    });
  }
});

describe('applyTenkiScope', () => {
  const cases: Array<{
    name: string;
    scope: { projectId: string; workspaceId?: string };
    want: Record<string, unknown>;
  }> = [
    {
      name: 'When the scope has a workspace then should apply both ids',
      scope: { projectId: 'project-1', workspaceId: 'workspace-1' },
      want: { projectId: 'project-1', workspaceId: 'workspace-1' },
    },
    {
      // An absent workspace must not be written as undefined: the SDK would send
      // the key and Tenki rejects it.
      name: 'When the scope has no workspace then should apply the project only',
      scope: { projectId: 'project-1' },
      want: { projectId: 'project-1' },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const options: Record<string, unknown> = {};

      applyTenkiScope(options, testCase.scope);

      assert.deepEqual(options, testCase.want);
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

interface Workspace {
  id: string;
  name?: string;
  projects: Array<{ id: string; name?: string }>;
}

function refusingClient(): TenkiScopeClient {
  return {
    async whoAmI() {
      throw new Error('whoAmI should not be called');
    },
  };
}

function identityClient(workspaces: Workspace[]): TenkiScopeClient {
  return {
    async whoAmI() {
      return { workspaces };
    },
  };
}
