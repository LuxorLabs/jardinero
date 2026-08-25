import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from './store.js';
import { type StoreFixture, createTestStore } from '../testing/store.js';

const RUN_ID = '6208e9eb-1490-4288-8547-5ccb7d214b91';

let fixture: StoreFixture;
let store: Store;

beforeEach(() => {
  fixture = createTestStore();
  store = fixture.store;
});

afterEach(() => {
  fixture.cleanup();
});

describe('Store.listSandboxRunArtifacts', () => {
  test('When the run wrote artifacts then should list them by name', () => {
    store.writeSandboxRunArtifact(RUN_ID, 'summary.md', 'done');
    store.writeSandboxRunArtifact(RUN_ID, path.join('logs', 'codex.log'), 'hello');

    const artifacts = store.listSandboxRunArtifacts(RUN_ID);

    assert.deepEqual(
      artifacts.map((artifact) => artifact.name),
      ['logs/codex.log', 'summary.md'],
    );
    assert.equal(artifacts[1].path, `runs/${RUN_ID}/artifacts/summary.md`);
    assert.equal(artifacts[1].url, `/dashboard/api/sandbox-runs/${RUN_ID}/artifacts/summary.md`);
    assert.equal(artifacts[1].size_bytes, 4);
  });

  test('When the run wrote nothing then should return an empty list', () => {
    assert.deepEqual(store.listSandboxRunArtifacts(RUN_ID), []);
  });

  // A symlink could point anywhere on the host, so it is not an artifact.
  test('When a symlink sits among the artifacts then should leave it out', () => {
    store.writeSandboxRunArtifact(RUN_ID, 'summary.md', 'done');
    const artifactRoot = path.join(store.runsDir, RUN_ID, 'artifacts');
    symlinkSync(path.join(artifactRoot, 'summary.md'), path.join(artifactRoot, 'link.md'));

    assert.deepEqual(
      store.listSandboxRunArtifacts(RUN_ID).map((artifact) => artifact.name),
      ['summary.md'],
    );
  });

  test('When the artifacts path is a file then should return an empty list', () => {
    mkdirSync(path.join(store.runsDir, RUN_ID), { recursive: true });
    writeFileSync(path.join(store.runsDir, RUN_ID, 'artifacts'), 'not a directory');

    assert.deepEqual(store.listSandboxRunArtifacts(RUN_ID), []);
  });

  // Anything other than a missing directory is a broken data directory, and
  // reporting no artifacts would hide it.
  test('When the run directory is unreadable then should return error', () => {
    writeFileSync(path.join(store.runsDir, RUN_ID), 'not a directory');

    assert.throws(() => store.listSandboxRunArtifacts(RUN_ID), { code: 'ENOTDIR' });
  });

  test('When the run id is not a uuid then should return error', () => {
    assert.throws(() => store.listSandboxRunArtifacts('../etc'), /Unsafe sandbox run id/);
  });
});

describe('Store.readSandboxRunArtifact', () => {
  const cases: Array<{ name: string; artifactName: string; wantContent?: string }> = [
    {
      name: 'When the artifact exists then should return its content',
      artifactName: 'summary.md',
      wantContent: 'done',
    },
    {
      name: 'When the artifact is unknown then should return nothing',
      artifactName: 'nope.md',
    },
    {
      // Only a listed artifact can be read, which is what keeps a crafted name from
      // reaching outside the run directory.
      name: 'When the name escapes the run directory then should return nothing',
      artifactName: '../../state.db',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      store.writeSandboxRunArtifact(RUN_ID, 'summary.md', 'done');

      const artifact = store.readSandboxRunArtifact(RUN_ID, testCase.artifactName);

      assert.equal(artifact?.content.toString(), testCase.wantContent);
    });
  }
});

describe('Store.writeSandboxRunArtifact', () => {
  const cases: Array<{ name: string; artifactName: string; wantRelativePath?: string }> = [
    {
      name: 'When the name is plain then should write it under the run',
      artifactName: 'summary.md',
      wantRelativePath: `runs/${RUN_ID}/artifacts/summary.md`,
    },
    {
      name: 'When the name is nested then should create the directories',
      artifactName: 'logs/codex.log',
      wantRelativePath: `runs/${RUN_ID}/artifacts/logs/codex.log`,
    },
    {
      name: 'When the name climbs out of the run then should return error',
      artifactName: '../../escaped.md',
    },
    {
      name: 'When the name is absolute then should return error',
      artifactName: '/etc/passwd',
    },
    {
      name: 'When the name climbs out mid-path then should return error',
      artifactName: 'logs/../../escaped.md',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      if (!testCase.wantRelativePath) {
        assert.throws(
          () => store.writeSandboxRunArtifact(RUN_ID, testCase.artifactName, 'x'),
          /Unsafe artifact path/,
        );
        return;
      }

      const relativePath = store.writeSandboxRunArtifact(RUN_ID, testCase.artifactName, 'x');

      assert.equal(relativePath, testCase.wantRelativePath);
      assert.equal(
        store.readSandboxRunArtifact(RUN_ID, testCase.artifactName)?.content.toString(),
        'x',
      );
    });
  }

  test('When the run id is not a uuid then should return error', () => {
    assert.throws(
      () => store.writeSandboxRunArtifact('../etc', 'summary.md', 'x'),
      /Unsafe sandbox run id/,
    );
  });
});
