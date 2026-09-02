import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadConfig } from '../../config.js';
import type { SandboxRunState } from '../../store/types.js';
import {
  classifySandboxForReap,
  createTenkiReaper,
  reconcileTenkiSandboxes,
  type ReapableSessionHandle,
  type ReapClassification,
  type ReapSummary,
} from './tenki-reaper.js';
import { createTestStore } from '../../testing/store.js';

type TenkiSdk = typeof import('@tenkicloud/sandbox');

describe('classifySandboxForReap', () => {
  const classifierCases: Array<{
    name: string;
    session: { id: string; state: string; metadata: Record<string, string> };
    statuses: Record<string, SandboxRunState>;
    want: ReapClassification;
  }> = [
    {
      name: 'When sandbox is not ours then should skip foreign',
      session: { id: 's1', state: 'RUNNING', metadata: { app: 'someone-else', run_id: 'run-1' } },
      statuses: { 'run-1': 'orphaned' },
      want: 'skip_foreign',
    },
    {
      name: 'When sandbox has no app metadata then should skip foreign',
      session: { id: 's1', state: 'RUNNING', metadata: { run_id: 'run-1' } },
      statuses: { 'run-1': 'orphaned' },
      want: 'skip_foreign',
    },
    {
      name: 'When session is terminating then should skip terminal state',
      session: { id: 's1', state: 'TERMINATING', metadata: meta({ run_id: 'run-1' }) },
      statuses: { 'run-1': 'orphaned' },
      want: 'skip_terminal_state',
    },
    {
      name: 'When session is terminated then should skip terminal state',
      session: { id: 's1', state: 'TERMINATED', metadata: meta({ run_id: 'run-1' }) },
      statuses: { 'run-1': 'succeeded' },
      want: 'skip_terminal_state',
    },
    {
      name: 'When `run_id` metadata is missing then should skip unowned run',
      session: { id: 's1', state: 'PAUSED', metadata: { app: 'jardinero' } },
      statuses: {},
      want: 'skip_unowned_run',
    },
    {
      name: 'When run is unknown to this store then should skip unowned run',
      session: { id: 's1', state: 'PAUSED', metadata: meta({ run_id: 'peer-run' }) },
      statuses: {},
      want: 'skip_unowned_run',
    },
    {
      name: 'When run is still pending then should skip active run',
      session: { id: 's1', state: 'CREATING', metadata: meta({ run_id: 'run-1' }) },
      statuses: { 'run-1': 'pending' },
      want: 'skip_active_run',
    },
    {
      name: 'When run is still running then should skip active run',
      session: { id: 's1', state: 'RUNNING', metadata: meta({ run_id: 'run-1' }) },
      statuses: { 'run-1': 'running' },
      want: 'skip_active_run',
    },
    {
      name: 'When run is orphaned then should reap terminal run',
      session: { id: 's1', state: 'PAUSED', metadata: meta({ run_id: 'run-1' }) },
      statuses: { 'run-1': 'orphaned' },
      want: 'reap_terminal_run',
    },
    {
      name: 'When run is succeeded then should reap terminal run',
      session: { id: 's1', state: 'RUNNING', metadata: meta({ run_id: 'run-1' }) },
      statuses: { 'run-1': 'succeeded' },
      want: 'reap_terminal_run',
    },
    {
      name: 'When run is failed then should reap terminal run',
      session: { id: 's1', state: 'PAUSED', metadata: meta({ run_id: 'run-1' }) },
      statuses: { 'run-1': 'failed' },
      want: 'reap_terminal_run',
    },
    {
      name: 'When run is aborted then should reap terminal run',
      session: { id: 's1', state: 'PAUSED', metadata: meta({ run_id: 'run-1' }) },
      statuses: { 'run-1': 'aborted' },
      want: 'reap_terminal_run',
    },
    {
      name: 'When run is skipped then should reap terminal run',
      session: { id: 's1', state: 'PAUSED', metadata: meta({ run_id: 'run-1' }) },
      statuses: { 'run-1': 'skipped' },
      want: 'reap_terminal_run',
    },
  ];

  for (const c of classifierCases) {
    test(c.name, () => {
      const decision = classifySandboxForReap(c.session, (runId) => c.statuses[runId]);
      assert.equal(decision, c.want);
    });
  }
});

describe('reconcileTenkiSandboxes', () => {
  const cases: Array<{
    name: string;
    sessions: SessionSpec[];
    statuses: Record<string, SandboxRunState>;
    closeTimeoutMs?: number;
    auditThrows?: boolean;
    wantClosed: string[];
    wantReaped: string[];
    wantFailures: string[];
    wantSummary: ReapSummary;
  }> = [
    {
      name: 'When sessions mix states then should reap only the terminal runs',
      sessions: [
        { id: 'leak', metadata: meta({ run_id: 'run-terminal' }) },
        { id: 'busy', metadata: meta({ run_id: 'run-active' }), state: 'RUNNING' },
        { id: 'foreign', metadata: { app: 'other', run_id: 'run-terminal' } },
        { id: 'unowned', metadata: { app: 'jardinero' } },
      ],
      statuses: { 'run-terminal': 'orphaned', 'run-active': 'running' },
      wantClosed: ['leak'],
      wantReaped: ['leak'],
      wantFailures: [],
      wantSummary: {
        listed: 4,
        reaped: 1,
        failed: 0,
        byClass: classCounts({
          reap_terminal_run: 1,
          skip_active_run: 1,
          skip_foreign: 1,
          skip_unowned_run: 1,
        }),
      },
    },
    {
      // A throwing close does not abort the sweep; the sandboxes behind it are
      // still reaped.
      name: 'When a close throws then should record the failure and keep sweeping',
      sessions: [
        { id: 'first', metadata: meta({ run_id: 'run-1' }), close: 'throw' },
        { id: 'second', metadata: meta({ run_id: 'run-2' }) },
      ],
      statuses: { 'run-1': 'orphaned', 'run-2': 'failed' },
      wantClosed: ['first', 'second'],
      wantReaped: ['second'],
      wantFailures: ['first'],
      wantSummary: {
        listed: 2,
        reaped: 1,
        failed: 1,
        byClass: classCounts({ reap_terminal_run: 2 }),
      },
    },
    {
      name: 'When a close hangs then should time out and count a failure',
      sessions: [{ id: 'stuck', metadata: meta({ run_id: 'run-1' }), close: 'hang' }],
      statuses: { 'run-1': 'orphaned' },
      closeTimeoutMs: 20,
      wantClosed: ['stuck'],
      wantReaped: [],
      wantFailures: ['stuck'],
      wantSummary: {
        listed: 1,
        reaped: 0,
        failed: 1,
        byClass: classCounts({ reap_terminal_run: 1 }),
      },
    },
    {
      // The close succeeded, so the sandbox is a reap and not a failure; a broken
      // bookkeeping callback must not double-count it or reach onReapFailed.
      name: 'When the audit callback throws then should still count the reap',
      sessions: [{ id: 'leak', metadata: meta({ run_id: 'run-1' }) }],
      statuses: { 'run-1': 'orphaned' },
      auditThrows: true,
      wantClosed: ['leak'],
      wantReaped: ['leak'],
      wantFailures: [],
      wantSummary: {
        listed: 1,
        reaped: 1,
        failed: 0,
        byClass: classCounts({ reap_terminal_run: 1 }),
      },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const closed: string[] = [];
      const reaped: string[] = [];
      const failures: string[] = [];

      const summary = await reconcileTenkiSandboxes({
        listSessions: async () => testCase.sessions.map((spec) => fakeSession(spec, closed)),
        lookupRunStatus: (runId) => testCase.statuses[runId],
        closeTimeoutMs: testCase.closeTimeoutMs ?? 1_000,
        onReaped: (session) => {
          reaped.push(session.id);
          if (testCase.auditThrows) throw new Error('audit write failed');
        },
        onReapFailed: (session) => failures.push(session.id),
      });

      assert.deepEqual(closed, testCase.wantClosed);
      assert.deepEqual(reaped, testCase.wantReaped);
      assert.deepEqual(failures, testCase.wantFailures);
      assert.deepEqual(summary, testCase.wantSummary);
    });
  }
});

describe('a close that rejects after the reaper stopped waiting', () => {
  test('When close rejects after the timeout then should not leak a rejection', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const session: ReapableSessionHandle = {
        id: 'slow',
        state: 'PAUSED',
        metadata: meta({ run_id: 'run-1' }),
        close: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('late network failure')), 40);
          }),
      };

      const summary = await reconcileTenkiSandboxes({
        listSessions: async () => [session],
        lookupRunStatus: () => 'orphaned',
        closeTimeoutMs: 10,
      });
      assert.equal(summary.failed, 1);

      // Give the late rejection time to fire and be swallowed by the handler.
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.deepEqual(rejections, []);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});

describe('createTenkiReaper', () => {
  test('When a run is terminal then should reap its sandbox and audit both outcomes', async () => {
    const { store, dataPath: tempDir, cleanup: closeStore } = createTestStore();
    const config = loadConfig();
    config.store.dataPath = tempDir;
    try {
      const repositoryId = store.upsertRepository('acme/webapp').id;
      const instance = store.openPrMaintainer({ repositoryId, pullRequestNumber: 4688 });
      const terminal = store.startSandboxRun({
        agentName: 'PrMaintainer',
        workflowType: 'pr_maintainer',
        workflowInstanceId: instance.id,
      });
      store.finishSandboxRun(terminal.id, { runState: 'failed' });

      const unclosable = store.startSandboxRun({
        agentName: 'PrMaintainer',
        workflowType: 'pr_maintainer',
        workflowInstanceId: instance.id,
      });
      store.finishSandboxRun(unclosable.id, { runState: 'failed' });

      const active = store.startSandboxRun({
        agentName: 'PrMaintainer',
        workflowType: 'pr_maintainer',
        workflowInstanceId: instance.id,
      });
      store.markSandboxRunRunning(active.id);

      const recordedTypes: string[] = [];
      const originalAppend = store.appendEvent.bind(store);
      store.appendEvent = (input) => {
        recordedTypes.push(input.eventType);
        originalAppend(input);
      };

      const closed: string[] = [];
      const sessions = [
        fakeSession({ id: 'leak', metadata: meta({ run_id: terminal.id }) }, closed),
        fakeSession(
          { id: 'broken', metadata: meta({ run_id: unclosable.id }), close: 'throw' },
          closed,
        ),
        fakeSession(
          { id: 'busy', metadata: meta({ run_id: active.id }), state: 'RUNNING' },
          closed,
        ),
      ];

      const reaper = createTenkiReaper(config, {}, store, {
        listSessions: async () => sessions,
      });
      const summary = await reaper.reapOnce();

      assert.deepEqual(closed, ['leak', 'broken']);
      assert.equal(summary.reaped, 1);
      assert.equal(summary.failed, 1);
      assert.ok(recordedTypes.includes('orchestrator.leaked_sandbox_closed'));
      assert.ok(recordedTypes.includes('orchestrator.leaked_sandbox_close_failed'));
    } finally {
      closeStore();
    }
  });

  test('When a sweep lists sandboxes then should filter on the `jardinero` tag and close the client', async () => {
    const { store, cleanup: closeStore } = createTestStore();
    try {
      const listOptions: Array<Record<string, unknown>> = [];
      const closed: string[] = [];
      const reaper = createTenkiReaper(loadConfig(), { TENKI_WORKSPACE_ID: 'workspace-1' }, store, {
        loadSdk: async () => fakeSdk(listOptions, closed),
      });

      const summary = await reaper.reapOnce();

      assert.equal(summary.listed, 0);
      assert.deepEqual(listOptions, [{ workspaceId: 'workspace-1', tags: ['jardinero'] }]);
      assert.deepEqual(closed, ['client']);
    } finally {
      closeStore();
    }
  });
});

function meta(overrides: Record<string, string> = {}): Record<string, string> {
  return { app: 'jardinero', run_id: 'run-1', workflow: 'pr_maintain', ...overrides };
}

interface SessionSpec {
  id: string;
  metadata: Record<string, string>;
  state?: string;
  // Makes close reject or hang, so the reap-failure and timeout paths are reachable.
  close?: 'ok' | 'throw' | 'hang';
}

// A fake listed sandbox with a spyable close().
function fakeSession(spec: SessionSpec, closed: string[]): ReapableSessionHandle {
  return {
    id: spec.id,
    state: spec.state ?? 'PAUSED',
    metadata: spec.metadata,
    close: async () => {
      closed.push(spec.id);
      if (spec.close === 'throw') throw new Error(`close failed for ${spec.id}`);
      if (spec.close === 'hang') await new Promise(() => {});
    },
  };
}

function classCounts(
  counts: Partial<Record<ReapClassification, number>>,
): Record<ReapClassification, number> {
  return {
    reap_terminal_run: 0,
    skip_foreign: 0,
    skip_terminal_state: 0,
    skip_active_run: 0,
    skip_unowned_run: 0,
    ...counts,
  };
}

// fakeSdk stands in for the SDK module: the client the sweep builds, the listing
// it answers with, and the close it records.
function fakeSdk(listOptions: Array<Record<string, unknown>>, closed: string[]): TenkiSdk {
  return {
    TenkiSandbox: class {
      async list(options: Record<string, unknown>): Promise<ReapableSessionHandle[]> {
        listOptions.push(options);
        return [];
      }
      close(): void {
        closed.push('client');
      }
    },
  } as unknown as TenkiSdk;
}
