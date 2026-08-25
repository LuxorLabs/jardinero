import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { healthResponse } from './health.js';

describe('healthResponse', () => {
  test('When the probe is answered then should report the version and what is running', () => {
    const response = healthResponse({
      store: { countRunningSandboxRuns: () => 3 },
      appVersion: '0.2.1',
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      ok: true,
      running: 3,
      version: '0.2.1',
    });
  });
});
