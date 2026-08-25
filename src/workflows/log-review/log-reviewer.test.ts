import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type AppConfig, loadConfig } from '../../config.js';
import { logReviewRepos, logReviewTargetsFor } from './log-reviewer.js';

// A repository with two namespaces and one with a single namespace, which is the
// whole of what these two functions branch on.
const TARGETS = [
  { repo: 'acme/widgets', namespace: 'production', clusters: ['demo'], services: ['api'] },
  { repo: 'acme/widgets', namespace: 'billing', clusters: ['demo'], services: ['billing'] },
  { repo: 'acme/gadgets', namespace: 'production', clusters: ['demo'], services: ['gadget-api'] },
];

function configWithTargets(): AppConfig {
  const config = loadConfig();
  config.workflows.logReviewer.repos = TARGETS;
  return config;
}

describe('logReviewRepos', () => {
  test('When the config is loaded then should return its configured entries', () => {
    const config = configWithTargets();

    assert.equal(logReviewRepos(config), config.workflows.logReviewer.repos);
  });
});

describe('logReviewTargetsFor', () => {
  test('When no repo is given then should return every entry', () => {
    const config = configWithTargets();

    assert.deepEqual(logReviewTargetsFor(config), config.workflows.logReviewer.repos);
  });

  test('When a monorepo is given without a namespace then should return every entry', () => {
    const targets = logReviewTargetsFor(configWithTargets(), { repo: 'acme/widgets' });

    assert.deepEqual(targets.map((target) => target.namespace).sort(), ['billing', 'production']);
  });

  test('When a repo and namespace are given then should return that entry only', () => {
    const targets = logReviewTargetsFor(configWithTargets(), {
      repo: 'acme/widgets',
      namespace: 'billing',
    });

    assert.equal(targets.length, 1);
    assert.equal(targets[0].namespace, 'billing');
  });

  test('When the repo is unknown then should return error', () => {
    assert.throws(
      () => logReviewTargetsFor(configWithTargets(), { repo: 'acme/nope' }),
      /Unknown log review repo/,
    );
  });

  test('When the namespace is unknown for the repo then should return error', () => {
    assert.throws(
      () => logReviewTargetsFor(configWithTargets(), { repo: 'acme/widgets', namespace: 'nope' }),
      /Unknown log review namespace/,
    );
  });
});
