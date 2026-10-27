import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, test } from 'node:test';

import { createHttpFixture } from '../../../src/testing/http.js';

describe('Requests whose path the URL parser rewrites', () => {
  test('When a path climbs from a webhook route to the dashboard then should answer 404', async () => {
    const fixture = await createHttpFixture();
    try {
      const canonical = await rawGet(fixture.baseUrl, '/dashboard/api/agents');
      assert.equal(canonical.status, 200);

      for (const path of [
        '/webhooks/github/%2e%2e/%2e%2e/dashboard/api/agents',
        '/webhooks/github/%2E%2E/%2E%2E/dashboard/api/agents',
        '/webhooks/github/../../dashboard/api/agents',
      ]) {
        const climbed = await rawGet(fixture.baseUrl, path);
        assert.equal(climbed.status, 404, path);
        assert.deepEqual(JSON.parse(climbed.body), { error: 'not_found' }, path);
      }
    } finally {
      await fixture.cleanup();
    }
  });
});

// rawGet sends the path byte for byte; fetch would resolve the dot segments before sending.
function rawGet(baseUrl: string, path: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname, port, path, method: 'GET' }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () =>
        resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}
