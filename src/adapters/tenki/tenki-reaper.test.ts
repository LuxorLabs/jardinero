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
} from './tenki-reaper.js';
import { createTestStore } from '../../testing/store.js';

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
  test('When sessions mix states then should reap only terminal runs', async () => {
    const closed: string[] = [];
    const statuses: Record<string, SandboxRunState> = {
      'run-terminal': 'orphaned',
      'run-active': 'running',
    };
    const sessions = [
      fakeSession('leak', meta({ run_id: 'run-terminal' }), closed),
      fakeSession('busy', meta({ run_id: 'run-active' }), closed, 'ok', 'RUNNING'),
      fakeSession('foreign', { app: 'other', run_id: 'run-terminal' }, closed),
      fakeSession('unowned', { app: 'jardinero' }, closed),
    ];
    const reaped: string[] = [];

    const summary = await reconcileTenkiSandboxes({
      listSessions: async () => sessions,
      lookupRunStatus: (runId) => statuses[runId],
      closeTimeoutMs: 1_000,
      onReaped: (session) => reaped.push(session.id),
    });

    assert.deepEqual(closed, ['leak']);
    assert.deepEqual(reaped, ['leak']);
    assert.equal(summary.listed, 4);
    assert.equal(summary.reaped, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.byClass.reap_terminal_run, 1);
    assert.equal(summary.byClass.skip_active_run, 1);
    assert.equal(summary.byClass.skip_foreign, 1);
    assert.equal(summary.byClass.skip_unowned_run, 1);
  });

  test('When a close throws then should record failure and continue', async () => {
    const closed: string[] = [];
    const statuses: Record<string, SandboxRunState> = { 'run-1': 'orphaned', 'run-2': 'failed' };
    const failures: string[] = [];
    const sessions = [
      fakeSession('first', meta({ run_id: 'run-1' }), closed, 'throw'),
      fakeSession('second', meta({ run_id: 'run-2' }), closed, 'ok'),
    ];

    const summary = await reconcileTenkiSandboxes({
      listSessions: async () => sessions,
      lookupRunStatus: (runId) => statuses[runId],
      closeTimeoutMs: 1_000,
      onReapFailed: (session) => failures.push(session.id),
    });

    // The throwing close does not abort the sweep; the second sandbox is still reaped.
    assert.deepEqual(closed, ['first', 'second']);
    assert.deepEqual(failures, ['first']);
    assert.equal(summary.reaped, 1);
    assert.equal(summary.failed, 1);
  });

  test('When a close hangs then should time out and fail', async () => {
    const closed: string[] = [];
    const sessions = [fakeSession('stuck', meta({ run_id: 'run-1' }), closed, 'hang')];

    const summary = await reconcileTenkiSandboxes({
      listSessions: async () => sessions,
      lookupRunStatus: () => 'orphaned',
      closeTimeoutMs: 20,
    });

    assert.equal(summary.reaped, 0);
    assert.equal(summary.failed, 1);
  });

  test('When onReaped throws then should still count the reap', async () => {
    const closed: string[] = [];
    const failures: string[] = [];
    const sessions = [fakeSession('leak', meta({ run_id: 'run-1' }), closed)];

    const summary = await reconcileTenkiSandboxes({
      listSessions: async () => sessions,
      lookupRunStatus: () => 'orphaned',
      closeTimeoutMs: 1_000,
      onReaped: () => {
        throw new Error('audit write failed');
      },
      onReapFailed: (session) => failures.push(session.id),
    });

    // The close succeeded, so the sandbox is a reap, not a failure; a broken
    // bookkeeping callback must not double-count it or call onReapFailed.
    assert.deepEqual(closed, ['leak']);
    assert.equal(summary.reaped, 1);
    assert.equal(summary.failed, 0);
    assert.deepEqual(failures, []);
  });

  test('When close rejects after the timeout then should not leak a rejection', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // close() rejects well after the timeout has already won the race; the
      // abandoned promise must not surface as an unhandled rejection.
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
  test('When a run is terminal then should reap its sandbox and audit', async () => {
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
        fakeSession('leak', meta({ run_id: terminal.id }), closed),
        fakeSession('busy', meta({ run_id: active.id }), closed, 'ok', 'RUNNING'),
      ];

      const reaper = createTenkiReaper(config, {}, store, {
        listSessions: async () => sessions,
      });
      const summary = await reaper.reapOnce();

      assert.deepEqual(closed, ['leak']);
      assert.equal(summary.reaped, 1);
      assert.equal(summary.failed, 0);
      assert.ok(recordedTypes.includes('orchestrator.leaked_sandbox_closed'));
    } finally {
      closeStore();
    }
  });
});

function meta(overrides: Record<string, string> = {}): Record<string, string> {
  return { app: 'jardinero', run_id: 'run-1', workflow: 'pr_maintain', ...overrides };
}

// A fake listed sandbox with a spyable close(). closeBehavior lets a case make
// close reject or hang so the reap-failure and timeout paths are exercised.
function fakeSession(
  id: string,
  metadata: Record<string, string>,
  closed: string[],
  closeBehavior: 'ok' | 'throw' | 'hang' = 'ok',
  state = 'PAUSED',
): ReapableSessionHandle {
  return {
    id,
    state,
    metadata,
    close: async () => {
      closed.push(id);
      if (closeBehavior === 'throw') throw new Error(`close failed for ${id}`);
      if (closeBehavior === 'hang') await new Promise(() => {});
    },
  };
}
