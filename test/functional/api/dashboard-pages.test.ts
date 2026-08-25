import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { createHttpFixture } from '../../../src/testing/http.js';

describe('GET /', () => {
  test('When the root is opened then should redirect to the dashboard', async () => {
    const fixture = await createHttpFixture();
    try {
      const redirect = await fetch(`${fixture.baseUrl}/`, { redirect: 'manual' });
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get('location'), '/dashboard');

      const posted = await fetch(`${fixture.baseUrl}/`, { method: 'POST' });
      assert.equal(posted.status, 404);
      assert.deepEqual(await posted.json(), { error: 'not_found' });
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('GET /dashboard', () => {
  // One boot for the six routes: a row per tab would pay for a server to assert the
  // same thing six times.
  test('When a tab is opened directly then should serve the shell with that tab active', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      for (const [pathname, tab] of [
        ['/dashboard', 'overview'],
        ['/dashboard/overview', 'overview'],
        ['/dashboard/operation', 'operation'],
        ['/dashboard/requests', 'requests'],
        ['/dashboard/prs', 'prs'],
        ['/dashboard/events', 'events'],
        ['/dashboard/prompts', 'prompts'],
      ]) {
        const page = await fetch(`${fixture.baseUrl}${pathname}`, { redirect: 'manual' });
        assert.equal(page.status, 200, pathname);
        const html = await page.text();
        assert.match(html, /id="root"/, pathname);
        assert.match(html, new RegExp(`data-tab="${tab}"`), pathname);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test('When no app session exists then should serve the pages and the apis', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      const page = await fetch(`${fixture.baseUrl}/dashboard/operation`, { redirect: 'manual' });
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type') ?? '', /text\/html/);
      const html = await page.text();
      assert.match(html, /Jardinero Operator Dashboard/);
      assert.match(html, /id="root"/);
      assert.match(html, /data-tab="operation"/);
      assert.doesNotMatch(html, /admin-token/);

      const api = await fetch(`${fixture.baseUrl}/dashboard/api/session`);
      assert.equal(api.status, 200);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the spa bundle is served then should serve its hashed assets', async () => {
    const assetsDir = path.join(process.cwd(), 'dist/public/assets');
    assert.ok(existsSync(assetsDir), 'the dashboard bundle must be built first: make build-web');
    const asset = readdirSync(assetsDir).find((name) => name.endsWith('.js'));
    assert.ok(asset, 'the vite build should emit at least one js asset');
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      const served = await fetch(`${fixture.baseUrl}/dashboard/assets/${asset}`);
      assert.equal(served.status, 200);
      assert.equal(served.headers.get('content-type'), 'text/javascript; charset=utf-8');
      // Hashed filenames make the content immutable, unlike the favicons above.
      assert.match(served.headers.get('cache-control') ?? '', /immutable/);

      const unknown = await fetch(`${fixture.baseUrl}/dashboard/assets/nope-00000000.js`);
      assert.equal(unknown.status, 404);
      assert.deepEqual(await unknown.json(), { error: 'asset_not_found' });

      // Encoded so the client cannot normalize the traversal away before the
      // server's confinement check sees it.
      const traversal = await fetch(
        `${fixture.baseUrl}/dashboard/assets/%2e%2e%2f%2e%2e%2fpackage.json`,
      );
      assert.equal(traversal.status, 404);
      assert.deepEqual(await traversal.json(), { error: 'asset_not_found' });
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the spa bundle is served then should serve the favicon and manifest', async () => {
    // Emitted by the Vite build into dist/public, which is why the gate builds the web
    // bundle before it runs the tests.
    assert.ok(
      existsSync(path.join(process.cwd(), 'dist/public/index.html')),
      'the dashboard bundle must be built first: make build-web',
    );
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      const icon = await fetch(`${fixture.baseUrl}/dashboard/favicon.ico`, { redirect: 'manual' });
      assert.equal(icon.status, 200);
      assert.equal(icon.headers.get('content-type'), 'image/x-icon');
      assert.match(icon.headers.get('cache-control') ?? '', /max-age=86400/);
      assert.doesNotMatch(icon.headers.get('cache-control') ?? '', /immutable/);

      const png = await fetch(`${fixture.baseUrl}/dashboard/favicon-32x32.png`);
      assert.equal(png.status, 200);
      assert.equal(png.headers.get('content-type'), 'image/png');

      const manifest = await fetch(`${fixture.baseUrl}/dashboard/site.webmanifest`);
      assert.equal(manifest.status, 200);
      assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
      const body = (await manifest.json()) as { icons: Array<{ src: string }> };
      // Base-relative srcs resolve against /dashboard/site.webmanifest, not the origin root.
      for (const { src } of body.icons) assert.doesNotMatch(src, /^\//);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When a public file is requested then should not broaden static exposure', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      const response = await fetch(`${fixture.baseUrl}/dashboard/secret.png`, {
        redirect: 'manual',
      });
      assert.equal(response.status, 404);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When a dashboard api is called then should not expose raw capsule sql', async () => {
    const fixture = await createHttpFixture({ ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' });
    try {
      const overview = await fetch(`${fixture.baseUrl}/dashboard/api/overview`, {
        headers: { authorization: 'Bearer admin-token' },
      });
      assert.equal(overview.status, 200);
      const body = (await overview.json()) as {
        ok: boolean;
        machines: unknown[];
        open_instances: number;
      };
      assert.equal(body.ok, true);
      assert.equal(body.machines.length, 5);
      assert.equal(body.open_instances, 0);

      const rawSql = await fetch(`${fixture.baseUrl}/dashboard/api/sql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: 'SELECT * FROM sandbox_run' }),
      });
      assert.equal(rawSql.status, 404);
      assert.equal(((await rawSql.json()) as { error: string }).error, 'dashboard_route_not_found');
    } finally {
      await fixture.cleanup();
    }
  });
});
