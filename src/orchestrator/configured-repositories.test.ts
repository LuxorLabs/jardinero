import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { type AppConfig, loadConfig } from '../config.js';
import type { Store } from '../store/store.js';
import { type StoreFixture, createTestStore } from '../testing/store.js';
import { registerConfiguredRepositories } from './configured-repositories.js';

let fixture: StoreFixture;
let store: Store;

beforeEach(() => {
  fixture = createTestStore();
  store = fixture.store;
});

afterEach(() => {
  fixture.cleanup();
});

describe('registerConfiguredRepositories', () => {
  const cases: Array<{ name: string; arrange(config: AppConfig): void; want: string[] }> = [
    {
      name: 'When a log review target names a repository then should register it',
      arrange: (config) => {
        config.workflows.logReviewer.repos = [{ repo: 'acme/widgets', clusters: [], services: [] }];
        config.workflows.linearImplementer.teamRepos = {};
      },
      want: ['acme/widgets'],
    },
    {
      name: 'When two targets share a repository then should register it once',
      arrange: (config) => {
        config.workflows.logReviewer.repos = [
          { repo: 'acme/gadgets', namespace: 'production', clusters: [], services: [] },
          { repo: 'acme/gadgets', namespace: 'billing', clusters: [], services: [] },
        ];
        config.workflows.linearImplementer.teamRepos = {};
      },
      want: ['acme/gadgets'],
    },
    {
      name: 'When a team maps to one repository then should register it',
      arrange: (config) => {
        config.workflows.logReviewer.repos = [];
        config.workflows.linearImplementer.teamRepos = { JAR: 'acme/sprockets' };
      },
      want: ['acme/sprockets'],
    },
    {
      // A team can route per project or explicit issue reference, and every route is
      // a repository we work on.
      name: 'When a team has project and additional repos then should register all of them',
      arrange: (config) => {
        config.workflows.logReviewer.repos = [];
        config.workflows.linearImplementer.teamRepos = {
          LUX: {
            default: 'acme/gadgets',
            projects: { Energy: 'acme/energy' },
            repos: ['acme/docs'],
          },
        };
      },
      want: ['acme/docs', 'acme/energy', 'acme/gadgets'],
    },
    {
      name: 'When a Discord channel maps to a repository then should register it',
      arrange: (config) => {
        config.workflows.logReviewer.repos = [];
        config.workflows.linearImplementer.teamRepos = {};
        config.discord.repoChannels = { 'acme/sprockets': 'channel-1' };
      },
      want: ['acme/sprockets'],
    },
    {
      name: 'When nothing is configured then should register nothing',
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
      testCase.arrange(config);

      registerConfiguredRepositories(store, config);

      assert.deepEqual(
        store
          .queryReadOnly('SELECT full_name FROM repository ORDER BY full_name')
          .map((row) => (row as { full_name: string }).full_name),
        testCase.want,
      );
    });
  }

  // Boot runs on the database the last one left, so registering again must not open a
  // second row for a repository already there.
  test('When the repositories are already registered then should keep their ids', () => {
    const config = loadConfig();
    config.workflows.linearImplementer.teamRepos = { JAR: 'acme/sprockets' };

    const first = registerConfiguredRepositories(store, config).map(
      (name) => store.findRepositoryByFullName(name)?.id,
    );
    const second = registerConfiguredRepositories(store, config).map(
      (name) => store.findRepositoryByFullName(name)?.id,
    );

    assert.ok(first.length > 0);
    assert.deepEqual(second, first);
  });
});
