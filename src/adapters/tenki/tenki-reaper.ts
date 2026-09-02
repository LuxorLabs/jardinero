import type { AppConfig } from '../../config.js';
import { type Logger, logger } from '../../platform/logger.js';
import type { Store } from '../../store/store.js';
import type { SandboxRunState } from '../../store/types.js';
import {
  buildTenkiClientOptions,
  JARDINERO_SANDBOX_APP,
  resolveWorkspaceScope,
  SANDBOX_METADATA,
} from './tenki-scope.js';
import { loadTenkiSdk } from '../../orchestrator/worker/tenki-worker.js';

type TenkiSdk = typeof import('@tenkicloud/sandbox');

// Run states in which the run is finished; a live sandbox for one is a leak the
// reaper reclaims. Deliberately an allow-list of terminal states, NOT "anything
// that is not running", so a pending run and any future non-terminal state (e.g.
// a re-attach 'recovering') are never reaped out from under an orchestrator that
// still owns the sandbox.
const TERMINAL_RUN_STATUSES: ReadonlySet<SandboxRunState> = new Set([
  'succeeded',
  'failed',
  'aborted',
  'orphaned',
  'skipped',
]);

// Session states that are already gone or on their way out; nothing left to reap.
const TERMINAL_SESSION_STATES: ReadonlySet<string> = new Set(['TERMINATING', 'TERMINATED']);

export type ReapClassification =
  | 'reap_terminal_run'
  | 'skip_foreign'
  | 'skip_terminal_state'
  | 'skip_active_run'
  | 'skip_unowned_run';

// The read-only view the classifier needs; the real Tenki Session satisfies it.
export interface ReapableSession {
  readonly id: string;
  readonly state: string;
  readonly metadata: Record<string, string>;
}

// Decide whether a sandbox is a reclaimable leak. Keyed on the sandbox's run
// being terminal in THIS orchestrator's store: run ids are globally unique, so a
// terminal match is unambiguously our own finished run. That makes the reap safe
// even when the Tenki workspace is shared with another orchestrator instance (a
// peer's in-flight run is unknown here, not terminal, so it is left alone).
export function classifySandboxForReap(
  session: ReapableSession,
  lookupRunStatus: (runId: string) => SandboxRunState | undefined,
): ReapClassification {
  if (session.metadata[SANDBOX_METADATA.app] !== JARDINERO_SANDBOX_APP) return 'skip_foreign';
  if (TERMINAL_SESSION_STATES.has(session.state)) return 'skip_terminal_state';
  const runId = session.metadata[SANDBOX_METADATA.runId];
  if (!runId) return 'skip_unowned_run';
  const status = lookupRunStatus(runId);
  if (status === undefined) return 'skip_unowned_run';
  if (TERMINAL_RUN_STATUSES.has(status)) return 'reap_terminal_run';
  return 'skip_active_run';
}

// A listed sandbox the reaper can terminate.
export interface ReapableSessionHandle extends ReapableSession {
  close(): Promise<void>;
}

export interface ReconcileTenkiSandboxesDeps {
  listSessions: () => Promise<ReapableSessionHandle[]>;
  lookupRunStatus: (runId: string) => SandboxRunState | undefined;
  closeTimeoutMs: number;
  onReaped?: (session: ReapableSessionHandle) => void;
  onReapFailed?: (session: ReapableSessionHandle, error: unknown) => void;
  log?: Logger;
}

export interface ReapSummary {
  listed: number;
  reaped: number;
  failed: number;
  byClass: Record<ReapClassification, number>;
}

function emptyByClass(): Record<ReapClassification, number> {
  return {
    reap_terminal_run: 0,
    skip_foreign: 0,
    skip_terminal_state: 0,
    skip_active_run: 0,
    skip_unowned_run: 0,
  };
}

// One reconciliation cycle: list the workspace's sandboxes, terminate the leaked
// ones, and return a per-classification tally. Never throws for a single failed
// close; a close that hangs is bounded by closeTimeoutMs so one stuck sandbox
// cannot wedge the sweep.
export async function reconcileTenkiSandboxes(
  deps: ReconcileTenkiSandboxesDeps,
): Promise<ReapSummary> {
  const log = deps.log ?? logger.child('reaper');
  const sessions = await deps.listSessions();
  const summary: ReapSummary = {
    listed: sessions.length,
    reaped: 0,
    failed: 0,
    byClass: emptyByClass(),
  };

  const toReap: ReapableSessionHandle[] = [];
  for (const session of sessions) {
    const classification = classifySandboxForReap(session, deps.lookupRunStatus);
    summary.byClass[classification] += 1;
    if (classification === 'reap_terminal_run') toReap.push(session);
  }

  for (const session of toReap) {
    try {
      await closeWithTimeout(session, deps.closeTimeoutMs);
    } catch (error) {
      summary.failed += 1;
      deps.onReapFailed?.(session, error);
      log.warn('failed to reap leaked sandbox', {
        session: session.id,
        run: session.metadata[SANDBOX_METADATA.runId],
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    summary.reaped += 1;
    log.info('reaped leaked sandbox', {
      session: session.id,
      run: session.metadata[SANDBOX_METADATA.runId],
      workflow: session.metadata[SANDBOX_METADATA.workflow],
    });
    // Bookkeeping only; a failed audit/metric write must not turn a real reap
    // into a counted failure or a misleading sandbox_reap_failed record.
    try {
      deps.onReaped?.(session);
    } catch (error) {
      log.warn('reaped sandbox but its bookkeeping callback failed', {
        session: session.id,
        run: session.metadata[SANDBOX_METADATA.runId],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}

async function closeWithTimeout(session: ReapableSessionHandle, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out closing Tenki sandbox session after ${timeoutMs}ms.`)),
      timeoutMs,
    );
  });
  // Capture the close promise so that when the timeout wins the race, a later
  // rejection from the abandoned close still has a handler. An unhandled
  // rejection here would trip the orchestrator's fail-fast exit — exactly what
  // the reaper exists to prevent.
  const closePromise = session.close();
  closePromise.catch(() => {});
  try {
    await Promise.race([closePromise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface TenkiReaper {
  reapOnce: () => Promise<ReapSummary>;
}

export interface CreateTenkiReaperDeps {
  loadSdk?: () => Promise<TenkiSdk>;
  // Test seam: bypass the SDK entirely with a canned session list.
  listSessions?: () => Promise<ReapableSessionHandle[]>;
}

// Wires the reconciliation loop to the live Tenki workspace (list) and this
// orchestrator's store (run-status lookup, audit, metrics). Used on a schedule
// and once at boot to reclaim sandboxes stranded by a crash or restart.
export function createTenkiReaper(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
  store: Store,
  deps: CreateTenkiReaperDeps = {},
): TenkiReaper {
  const loadSdk = deps.loadSdk ?? loadTenkiSdk;
  const log = logger.child('reaper');

  const listSessions =
    deps.listSessions ??
    (async (): Promise<ReapableSessionHandle[]> => {
      const sdk = await loadSdk();
      // Closed once the listing is in: the v1 client dials on construction and
      // holds the connection open until it is.
      const sandbox = new sdk.TenkiSandbox(buildTenkiClientOptions(config, env));
      try {
        // Ask for our own tag so a sweep never pulls the workspace's foreign
        // sessions; ownership is still classifySandboxForReap's call.
        return await sandbox.list({
          ...resolveWorkspaceScope(config, env),
          tags: [JARDINERO_SANDBOX_APP],
        });
      } finally {
        sandbox.close();
      }
    });

  return {
    reapOnce: () =>
      reconcileTenkiSandboxes({
        listSessions,
        lookupRunStatus: (runId) => store.getSandboxRun(runId)?.runState,
        closeTimeoutMs: config.worker.sessionCloseTimeoutMs,
        log,
        onReaped: (session) => {
          store.appendEvent({
            eventType: 'orchestrator.leaked_sandbox_closed',
            metadata: {
              session_id: session.id,
              run_id: session.metadata[SANDBOX_METADATA.runId],
              workflow: session.metadata[SANDBOX_METADATA.workflow],
            },
          });
        },
        onReapFailed: (session, error) => {
          store.appendEvent({
            eventType: 'orchestrator.leaked_sandbox_close_failed',
            metadata: {
              session_id: session.id,
              run_id: session.metadata[SANDBOX_METADATA.runId],
              error: error instanceof Error ? error.message : String(error),
            },
          });
        },
      }),
  };
}
