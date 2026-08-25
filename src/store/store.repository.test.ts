import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from './store.js';
import { type StoreFixture, createTestStore } from '../testing/store.js';

let fixture: StoreFixture;
let store: Store;

beforeEach(() => {
  fixture = createTestStore();
  store = fixture.store;
});

afterEach(() => {
  fixture.cleanup();
});

describe('Store.upsertRepository', () => {
  test('When the repository is new then should create it enabled and lowercased', () => {
    const repository = store.upsertRepository('acme/Orchestrator');

    assert.equal(repository.fullName, 'acme/orchestrator');
    assert.equal(repository.isEnabled, true);
    assert.equal(repository.createdAt, repository.updatedAt);
  });

  test('When the same repository is upserted twice then should keep one row', () => {
    const first = store.upsertRepository('acme/orchestrator');
    const second = store.upsertRepository('acme/Orchestrator');

    assert.equal(second.id, first.id);
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(store.queryReadOnly('SELECT COUNT(*) AS total FROM repository').length, 1);
  });
});

describe('Store.findRepositoriesNamed', () => {
  const cases: Array<{ name: string; named: string; wantFullNames: string[] }> = [
    {
      name: 'When one repository is named that then should answer it',
      named: 'orchestrator',
      wantFullNames: ['acme/orchestrator'],
    },
    {
      name: 'When the name is written in another case then should still answer it',
      named: 'ORCHESTRATOR',
      wantFullNames: ['acme/orchestrator'],
    },
    {
      name: 'When two owners have a repository named that then should answer both',
      named: 'fleet',
      wantFullNames: ['acme/fleet', 'other-org/fleet'],
    },
    {
      // The half before the slash is the owner, so a full name is not a name.
      name: 'When the whole slug is given then should answer nothing',
      named: 'acme/orchestrator',
      wantFullNames: [],
    },
    {
      name: 'When nothing is named that then should answer nothing',
      named: 'webapp',
      wantFullNames: [],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      store.upsertRepository('acme/orchestrator');
      store.upsertRepository('acme/fleet');
      store.upsertRepository('other-org/fleet');

      assert.deepEqual(
        store
          .findRepositoriesNamed(testCase.named)
          .map((repository) => repository.fullName)
          .sort(),
        testCase.wantFullNames,
      );
    });
  }
});

describe('Store.getRepositoryById', () => {
  const cases: Array<{ name: string; id(storedId: string): string; wantFound: boolean }> = [
    {
      name: 'When the id is known then should return the repository',
      id: (storedId) => storedId,
      wantFound: true,
    },
    {
      name: 'When the id is unknown then should return nothing',
      id: () => 'missing',
      wantFound: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const stored = store.upsertRepository('acme/orchestrator');

      const found = store.getRepositoryById(testCase.id(stored.id));

      assert.deepEqual(found, testCase.wantFound ? stored : undefined);
    });
  }
});

describe('Store.findRepositoryByFullName', () => {
  const cases: Array<{ name: string; fullName: string; wantFound: boolean }> = [
    {
      name: 'When the name matches then should return the repository',
      fullName: 'acme/orchestrator',
      wantFound: true,
    },
    {
      name: 'When the name differs in case then should return the repository',
      fullName: 'acme/ORCHESTRATOR',
      wantFound: true,
    },
    {
      name: 'When the name is unknown then should return nothing',
      fullName: 'acme/nope',
      wantFound: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const stored = store.upsertRepository('acme/orchestrator');

      const found = store.findRepositoryByFullName(testCase.fullName);

      assert.deepEqual(found, testCase.wantFound ? stored : undefined);
    });
  }
});
