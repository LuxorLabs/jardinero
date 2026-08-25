import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadConfig } from '../../config.js';
import {
  dashboardExposureOptions,
  exposeDashboardOnStartup,
  exposeDashboardPort,
  type DashboardExposureOptions,
} from './dashboard-exposure.js';

describe('dashboardExposureOptions', () => {
  const SESSION_ID = '019ed418-997a-7ebe-93cb-ae18fe4b1346';

  const cases: Array<{
    name: string;
    env: NodeJS.ProcessEnv;
    hostname: string;
    port?: number;
    want: Partial<DashboardExposureOptions>;
  }> = [
    {
      // A plain host is not a sandbox, so the dashboard stays private unless asked.
      name: 'When the host is not a tenki sandbox then should default to disabled',
      env: {},
      hostname: 'session-hostname',
      want: { enabled: false, sessionId: 'session-hostname', port: 3000 },
    },
    {
      name: 'When the host is an orchestrator sandbox then should default to enabled',
      env: { JARDINERO_TEMPLATE_KIND: 'orchestrator' },
      hostname: 'session-hostname',
      want: { enabled: true },
    },
    {
      // Inside Tenki the hostname IS the session id, which is how a sandbox is
      // recognized without any env var set.
      name: 'When the hostname is a tenki session id then should default to enabled',
      env: {},
      hostname: SESSION_ID,
      want: { enabled: true, sessionId: SESSION_ID },
    },
    {
      name: 'When exposure is disabled explicitly then should stay disabled',
      env: { DASHBOARD_EXPOSE_ON_STARTUP: 'false', JARDINERO_TEMPLATE_KIND: 'orchestrator' },
      hostname: SESSION_ID,
      want: { enabled: false },
    },
    {
      name: 'When startup env options are set then should read them',
      env: {
        DASHBOARD_EXPOSE_ON_STARTUP: 'true',
        DASHBOARD_EXPOSE_SESSION_ID: 'session-from-env',
        DASHBOARD_EXPOSE_SLUG: 'jardinero-dashboard',
        DASHBOARD_EXPOSE_TTL_MINUTES: '90',
      },
      hostname: 'session-hostname',
      port: 3001,
      want: {
        enabled: true,
        sessionId: 'session-from-env',
        port: 3001,
        slug: 'jardinero-dashboard',
        ttlMs: 90 * 60_000,
      },
    },
    {
      name: 'When no session id is given then should use the hostname',
      env: { DASHBOARD_EXPOSE_ON_STARTUP: 'true' },
      hostname: SESSION_ID,
      want: { enabled: true, sessionId: SESSION_ID },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const config = loadConfig();
      if (testCase.port !== undefined) config.server.port = testCase.port;

      const options = dashboardExposureOptions(config, testCase.env, testCase.hostname);

      for (const [key, value] of Object.entries(testCase.want)) {
        assert.deepEqual(options[key as keyof DashboardExposureOptions], value, key);
      }
    });
  }
});

describe('exposeDashboardOnStartup', () => {
  test('When exposure is disabled then should not touch the sdk', async () => {
    const recorder = recordingStore();

    const exposed = await exposeDashboardOnStartup(loadConfig(), {}, recorder.store);

    assert.equal(exposed, undefined);
    assert.deepEqual(recorder.entries, []);
  });

  // Exposure is best effort: the orchestrator has to boot even when the sandbox
  // API is unreachable, so the failure is audited rather than thrown.
  const failureCases: Array<{ name: string; env: NodeJS.ProcessEnv }> = [
    {
      name: 'When the tenki credentials are given then should audit the failure to reach it',
      env: {
        DASHBOARD_EXPOSE_ON_STARTUP: '1',
        DASHBOARD_EXPOSE_SESSION_ID: 'session-123',
        TENKI_API_KEY: 'token',
        TENKI_API_URL: 'http://127.0.0.1:1',
      },
    },
    {
      name: 'When there are no tenki credentials then should audit the failure',
      env: { DASHBOARD_EXPOSE_ON_STARTUP: '1', DASHBOARD_EXPOSE_SESSION_ID: 'session-123' },
    },
  ];

  for (const testCase of failureCases) {
    test(testCase.name, async () => {
      const recorder = recordingStore();

      const exposed = await exposeDashboardOnStartup(loadConfig(), testCase.env, recorder.store);

      assert.equal(exposed, undefined);
      assert.equal(recorder.entries.length, 1);
      assert.equal(recorder.entries[0].type, 'orchestrator.dashboard_exposure_failed');
      assert.equal(recorder.entries[0].metadata?.session_id, 'session-123');
      assert.ok(recorder.entries[0].metadata?.error);
    });
  }
});

describe('exposeDashboardPort', () => {
  test('When exposure is enabled then should expose the requested port', async () => {
    const calls: unknown[] = [];
    const options: DashboardExposureOptions = {
      enabled: true,
      sessionId: 'session-123',
      port: 3000,
      slug: 'dash',
      ttlMs: 60_000,
    };
    const exposed = await exposeDashboardPort(options, {
      async get(sessionId) {
        calls.push(['get', sessionId]);
        return {
          async exposePort(port, exposeOptions) {
            calls.push(['exposePort', port, exposeOptions]);
            return {
              port,
              previewUrl: 'https://dash.example.test',
              previewUrlId: 'preview-123',
              slug: exposeOptions?.slug,
            };
          },
        };
      },
    });

    assert.deepEqual(calls, [
      ['get', 'session-123'],
      ['exposePort', 3000, { slug: 'dash', ttlMs: 60_000 }],
    ]);
    assert.equal(exposed?.previewUrl, 'https://dash.example.test');
  });

  test('When exposure is disabled then should do nothing', async () => {
    const exposed = await exposeDashboardPort(
      { enabled: false, sessionId: 'session-123', port: 3000 },
      {
        async get() {
          throw new Error('should not be called');
        },
      },
    );
    assert.equal(exposed, undefined);
  });
});

function recordingStore(): {
  store: Parameters<typeof exposeDashboardOnStartup>[2];
  entries: Array<{ type: string; metadata: Record<string, unknown> | undefined }>;
} {
  const entries: Array<{ type: string; metadata: Record<string, unknown> | undefined }> = [];
  return {
    store: {
      appendEvent: (input: { eventType: string; metadata?: Record<string, unknown> }) => {
        entries.push({ type: input.eventType, metadata: input.metadata });
      },
    } as unknown as Parameters<typeof exposeDashboardOnStartup>[2],
    entries,
  };
}
