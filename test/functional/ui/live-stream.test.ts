import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// The SPA opens the stream by URL, so nothing but a test keeps that URL and the route
// the server serves it on from drifting apart.
test('When the dashboard opens the live stream then should use the route the server serves', () => {
  const provider = readFileSync(
    path.resolve(process.cwd(), 'web/src/live/LiveProvider.tsx'),
    'utf8',
  );
  const server = readFileSync(
    path.resolve(process.cwd(), 'src/transport/dashboard/dashboard.ts'),
    'utf8',
  );

  assert.match(provider, /new EventSource\('\/dashboard\/api\/stream'\)/);
  assert.match(server, /url\.pathname === '\/dashboard\/api\/stream'/);
});
