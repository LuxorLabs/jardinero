import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { createHttpFixture } from '../../../src/testing/http.js';

describe('GET /health', () => {
  test('When requested then should report the pause state and the package version', async () => {
    const fixture = await createHttpFixture();
    try {
      const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
      const response = await fetch(`${fixture.baseUrl}/health`);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        running: 0,
        version: packageJson.version,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test('When a build version is baked in then should report it', async () => {
    const fixture = await createHttpFixture({ JARDINERO_BUILD_VERSION: 'v0.0.0-a1b2c3d' });
    try {
      const response = await fetch(`${fixture.baseUrl}/health`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { version: string };
      assert.equal(body.version, 'v0.0.0-a1b2c3d');
    } finally {
      await fixture.cleanup();
    }
  });
});
