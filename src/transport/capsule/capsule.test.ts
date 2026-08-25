import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { EventLogEntry, SandboxRunState, SandboxRun } from '../../store/types.js';
import { type CapsuleContext, capsuleResponse } from './capsule.js';

const RUN_ID = '6208e9eb-1490-4288-8547-5ccb7d214b91';

describe('capsuleResponse', () => {
  const cases: Array<{
    name: string;
    method?: string;
    path: string;
    rawBody?: string;
    wantStatus: number;
    check?(response: ReturnType<typeof capsuleResponse>, calls: Calls): void;
  }> = [
    {
      name: 'When runs are listed then should return them under the default limit',
      path: '/capsule/runs',
      wantStatus: 200,
      check: (response, calls) => {
        assert.deepEqual(calls.listSandboxRuns, [{ limit: 100, runState: undefined }]);
        assert.deepEqual(response.body, { runs: [] });
      },
    },
    {
      name: 'When the limit is not a number then should fall back to the default',
      path: '/capsule/runs?limit=nope&state=running',
      wantStatus: 200,
      check: (_response, calls) => {
        assert.deepEqual(calls.listSandboxRuns, [{ limit: 100, runState: 'running' }]);
      },
    },
    {
      name: 'When the run id is not a uuid then should return error',
      path: `/capsule/runs/${encodeURIComponent('../etc/passwd')}/events`,
      wantStatus: 400,
      check: (response, calls) => {
        assert.deepEqual(response.body, { error: 'invalid_run_id' });
        assert.deepEqual(calls.listEventsForSandboxRun, []);
      },
    },
    {
      // The event log is newline-delimited JSON, so it goes out verbatim rather
      // than re-encoded as a JSON body.
      name: 'When a run event log is read then should send it as raw ndjson',
      path: `/capsule/runs/${RUN_ID}/events`,
      wantStatus: 200,
      check: (response, calls) => {
        assert.deepEqual(calls.listEventsForSandboxRun, [RUN_ID]);
        assert.match(String(response.raw), /"eventType":"sandbox.ready"/);
        assert.equal(response.headers?.['content-type'], 'application/x-ndjson; charset=utf-8');
        assert.equal(response.body, undefined);
      },
    },
    {
      name: 'When a read-only query is posted then should return its rows',
      method: 'POST',
      path: '/capsule/sql',
      rawBody: JSON.stringify({ sql: 'SELECT 1', params: [7] }),
      wantStatus: 200,
      check: (response, calls) => {
        assert.deepEqual(calls.queries, [{ sql: 'SELECT 1', params: [7] }]);
        assert.deepEqual(response.body, { rows: [] });
      },
    },
    {
      name: 'When the query fields are missing then should query with empty defaults',
      method: 'POST',
      path: '/capsule/sql',
      rawBody: '{}',
      wantStatus: 200,
      check: (_response, calls) => {
        assert.deepEqual(calls.queries, [{ sql: '', params: [] }]);
      },
    },
    {
      name: 'When the capsule route is unknown then should return error',
      path: '/capsule/nope',
      wantStatus: 404,
      check: (response) => assert.deepEqual(response.body, { error: 'capsule_route_not_found' }),
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const fixture = createFixture();

      const response = capsuleResponse(fixture.context, {
        method: testCase.method ?? 'GET',
        url: new URL(testCase.path, 'http://localhost'),
        rawBody: testCase.rawBody ?? '',
      });

      assert.equal(response.status, testCase.wantStatus);
      testCase.check?.(response, fixture.calls);
    });
  }
});

interface Calls {
  listSandboxRuns: Array<{ limit: number; runState: SandboxRunState | undefined }>;
  listEventsForSandboxRun: string[];
  queries: Array<{ sql: string; params: unknown[] }>;
}

function createFixture() {
  const calls: Calls = { listSandboxRuns: [], listEventsForSandboxRun: [], queries: [] };

  const context: CapsuleContext = {
    store: {
      listSandboxRuns: (limit: number, runState?: SandboxRunState): SandboxRun[] => {
        calls.listSandboxRuns.push({ limit, runState });
        return [];
      },
      listEventsForSandboxRun: (runId: string): EventLogEntry[] => {
        calls.listEventsForSandboxRun.push(runId);
        return [
          {
            id: 'event-1',
            eventType: 'sandbox.ready',
            workflowType: 'pr_maintainer',
            workflowInstanceId: 'instance-1',
            sandboxRunId: runId,
            repositoryId: null,
            fromState: null,
            toState: null,
            metadata: null,
            createdAt: 1,
          },
        ];
      },
      queryReadOnly: (sql: string, params: never[]) => {
        calls.queries.push({ sql, params });
        return [];
      },
    },
  };

  return { context, calls };
}
