import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { type AppConfig, loadConfig } from './config.js';

// The bundled file is documentation plus commented examples. Anything it sets for
// real is a default written in two places, and src/config.ts is the one that owns them.
test('When the bundled config is loaded then should override nothing the code defaults set', () => {
  const emptyDir = mkdtempSync(path.join(tmpdir(), 'jardinero-empty-config-'));
  writeFileSync(path.join(emptyDir, 'empty.yaml'), '# no overrides\n');

  const bundled = loadConfig('config/local.yaml');
  const defaults = loadConfig('empty.yaml', emptyDir);

  assert.deepEqual(comparable(bundled), comparable(defaults));
});

// The example is documentation someone copies, so a key renamed out from under it
// has to fail here rather than in their cluster.
test('When the deployment example is loaded then should still be a valid config', () => {
  const config = loadConfig('examples/deploy/kubernetes/config.yaml');

  assert.equal(config.worker.runner, 'tenki');
  assert.equal(config.workflows.linearImplementer.enabled, true);
  assert.deepEqual(config.workflows.linearImplementer.teamRepos, {
    ENG: 'your-org/repo1',
    PLATFORM: {
      default: 'your-org/repo2',
      repos: ['your-org/repo3', 'your-org/repo4'],
      projects: { Billing: 'your-org/repo5' },
    },
  });
  assert.deepEqual(Object.keys(config.worker.repos), [
    'your-org/repo2',
    'your-org/repo3',
    'your-org/repo1',
  ]);
  // Each entry shows one knob, and what it omits falls back to worker.default.
  assert.deepEqual(config.worker.repos['your-org/repo2'].resources, {
    cpuCores: 8,
    memoryMb: 16384,
  });
  assert.deepEqual(config.worker.repos['your-org/repo3'].model, {
    generation: 'gpt-5.5',
    maxEffort: 'high',
  });
  assert.deepEqual(config.worker.repos['your-org/repo1'].secretEnvs, ['REPO1_TEST_DATABASE_URL']);
  // The commented-out blocks stay commented: an example that turns log review or
  // Discord on would demand credentials nobody copying it has yet.
  assert.equal(config.workflows.logReviewer.enabled, false);
  assert.equal(config.discord.enabled, false);
});

// Everything the loader derives from where it was loaded from, which is the one
// thing the two configs are expected to differ on.
function comparable(config: AppConfig): Omit<AppConfig, 'rootDir' | 'configPath' | 'store'> & {
  store: Omit<AppConfig['store'], 'dataPath' | 'schemaPath'>;
} {
  const { rootDir: _rootDir, configPath: _configPath, store, ...rest } = config;
  const { dataPath: _dataPath, schemaPath: _schemaPath, ...storeRest } = store;
  return { ...rest, store: storeRest };
}
