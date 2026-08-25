import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { resolveAppVersion } from './version.js';

describe('resolveAppVersion', () => {
  test('When the build stamped a version then should use it', () => {
    assert.equal(resolveAppVersion({ JARDINERO_BUILD_VERSION: 'v1.2.3' }), 'v1.2.3');
  });

  const fallbackCases: Array<{ name: string; env: NodeJS.ProcessEnv }> = [
    { name: 'When no build version is set then should fall back to package.json', env: {} },
    {
      // An empty or blank stamp is a build that did not substitute the value, so it
      // must not become the reported version.
      name: 'When the build version is blank then should fall back to package.json',
      env: { JARDINERO_BUILD_VERSION: '   ' },
    },
  ];

  for (const testCase of fallbackCases) {
    test(testCase.name, () => {
      const packaged = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

      assert.equal(resolveAppVersion(testCase.env), packaged.version);
    });
  }
});
