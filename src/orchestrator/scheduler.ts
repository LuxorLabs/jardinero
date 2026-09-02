import { type AppConfig, configuredRepositoryNames } from '../config.js';
import { type Logger, logger } from '../platform/logger.js';
import type { SqliteBackupFailure, Store } from '../store/store.js';
import { listOpenPullRequests } from '../adapters/github/github-pull-requests.js';

import type { EngineCommands } from './engine-commands.js';
import type { Orchestrator } from './orchestrator.js';
import type { ReapSummary } from '../adapters/tenki/tenki-reaper.js';

type BackupCycleReason = 'startup' | 'interval' | 'retry';

const DEFAULT_BACKUP_RETRY_DELAY_MS = 60_000;

export interface SchedulerOptions {
  store: Store;
  orchestrator: Pick<Orchestrator, 'prMaintainer'>;
  commands: Pick<EngineCommands, 'announceLogReview'>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  backupRetryDelayMs?: number;
  // One reaper sweep. Wired only under the Tenki runner; omitted (mock runner,
  // most tests) leaves the reaper disabled.
  reapSandboxesOnce?: () => Promise<ReapSummary>;
}

export class Scheduler {
  private logReviewInterval: NodeJS.Timeout | undefined;
  private backupInterval: NodeJS.Timeout | undefined;
  private backupRetryTimeout: NodeJS.Timeout | undefined;
  private backupInFlight = false;
  private prMaintainPollInterval: NodeJS.Timeout | undefined;
  private prSweepInFlight = false;
  private sandboxReaperInterval: NodeJS.Timeout | undefined;
  private sandboxReaperInFlight = false;
  private readonly store: Store;
  private readonly orchestrator: SchedulerOptions['orchestrator'];
  private readonly commands: SchedulerOptions['commands'];
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly backupRetryDelayMs: number;
  private readonly reapSandboxesOnce: (() => Promise<ReapSummary>) | undefined;
  private readonly log: Logger = logger.child('scheduler');

  constructor(
    private readonly config: AppConfig,
    options: SchedulerOptions,
  ) {
    this.store = options.store;
    this.orchestrator = options.orchestrator;
    this.commands = options.commands;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.backupRetryDelayMs = options.backupRetryDelayMs ?? DEFAULT_BACKUP_RETRY_DELAY_MS;
    this.reapSandboxesOnce = options.reapSandboxesOnce;
  }

  start(): void {
    this.startLogReview();
    this.startBackups();
    this.startPrMaintenancePolling();
    this.startSandboxReaper();
    this.log.info('scheduler started', {
      log_review_cron_min: this.config.workflows.logReviewer.enabled
        ? this.config.workflows.logReviewer.scanIntervalMin
        : 'off',
      pr_maintain_poll_min: this.config.workflows.prMaintainer.enabled
        ? this.config.workflows.prMaintainer.pollIntervalMin
        : 'off',
      sandbox_reaper_poll_min:
        this.reapSandboxesOnce && this.config.worker.sandboxReaperIntervalMin >= 1
          ? this.config.worker.sandboxReaperIntervalMin
          : 'off',
      backup_interval_min: this.config.store.backupIntervalMin,
    });
  }

  stop(): void {
    if (this.logReviewInterval) {
      clearInterval(this.logReviewInterval);
      this.logReviewInterval = undefined;
    }
    if (this.backupInterval) {
      clearInterval(this.backupInterval);
      this.backupInterval = undefined;
    }
    if (this.backupRetryTimeout) {
      clearTimeout(this.backupRetryTimeout);
      this.backupRetryTimeout = undefined;
    }
    if (this.prMaintainPollInterval) {
      clearInterval(this.prMaintainPollInterval);
      this.prMaintainPollInterval = undefined;
    }
    if (this.sandboxReaperInterval) {
      clearInterval(this.sandboxReaperInterval);
      this.sandboxReaperInterval = undefined;
    }
  }

  // Sweep the Tenki workspace for leaked sandboxes (a run's sandbox that outlived
  // the run). Fires once at startup to reclaim anything a crash or restart
  // stranded, then on an interval. Disabled when no reaper was wired (mock
  // runner) or sandbox_reaper_interval_min is < 1.
  private startSandboxReaper(): void {
    if (!this.reapSandboxesOnce || this.sandboxReaperInterval) return;
    if (this.config.worker.sandboxReaperIntervalMin < 1) return;
    this.runSandboxReaper('startup');
    this.sandboxReaperInterval = setInterval(
      () => this.runSandboxReaper('interval'),
      this.config.worker.sandboxReaperIntervalMin * 60_000,
    );
  }

  // One reaper cycle. The in-flight guard keeps a slow sweep from overlapping the
  // next tick; a failed cycle is audited and never propagates.
  runSandboxReaper(reason: 'startup' | 'interval'): void {
    const reap = this.reapSandboxesOnce;
    if (!reap) return;
    if (this.sandboxReaperInFlight) return;
    this.sandboxReaperInFlight = true;
    void reap()
      .then((summary) => {
        // Stay quiet on idle sweeps; only narrate cycles that did or tried something.
        if (summary.reaped > 0 || summary.failed > 0) {
          this.log.info('sandbox reaper complete', {
            reason,
            listed: summary.listed,
            reaped: summary.reaped,
            failed: summary.failed,
          });
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error('sandbox reaper cycle failed', { reason, error: message });
        this.auditCycleFailure('orchestrator.leaked_sandbox_sweep_failed', {
          reason,
          error: message,
        });
      })
      .finally(() => {
        this.sandboxReaperInFlight = false;
      });
  }

  private startLogReview(): void {
    if (!this.config.workflows.logReviewer.enabled || this.logReviewInterval) return;
    if (this.config.workflows.logReviewer.scanIntervalMin < 1) return;
    this.dispatchLogReviewCycle('startup');
    this.logReviewInterval = setInterval(() => {
      this.dispatchLogReviewCycle('hourly_cron');
    }, this.config.workflows.logReviewer.scanIntervalMin * 60_000);
  }

  // dispatchLogReviewCycle announces one scan per configured target. A target already
  // being scanned is left alone by the machine.
  private dispatchLogReviewCycle(reason: 'startup' | 'hourly_cron'): void {
    this.log.info('cron: scanning logs', { reason });
    void this.commands.announceLogReview({ askedBy: 'cron' }).then((announcement) => {
      for (const repo of announcement.unknownRepositories) {
        this.log.error('cron: log review target is not a known repository', { repo });
      }
    });
  }

  private startPrMaintenancePolling(): void {
    if (!this.config.workflows.prMaintainer.enabled || this.prMaintainPollInterval) return;
    if (this.config.workflows.prMaintainer.pollIntervalMin < 1) return;
    this.prMaintainPollInterval = setInterval(
      () => this.runPrMaintenancePollCycle(),
      this.config.workflows.prMaintainer.pollIntervalMin * 60_000,
    );
  }

  // sweepPullRequests announces every open pull request we may follow, which is the
  // safety net for a webhook that never arrived; the machine decides what is new.
  private sweepPullRequests(): void {
    const token = this.env[this.config.worker.githubTokenEnv];
    if (!token) {
      this.log.error('cannot sweep pull requests', { reason: 'missing_github_token' });
      return;
    }
    if (this.prSweepInFlight) return;
    this.prSweepInFlight = true;
    void Promise.all(
      configuredRepositoryNames(this.config).map((repo) => this.sweepRepository(repo, token)),
    ).finally(() => {
      this.prSweepInFlight = false;
    });
  }

  // sweepRepository announces the followable pull requests of one repository.
  private async sweepRepository(repo: string, token: string): Promise<void> {
    try {
      const open = await listOpenPullRequests({ repo, token, fetchImpl: this.fetchImpl });
      const repository = this.store.upsertRepository(repo);
      for (const pullRequest of open) {
        const error = await this.orchestrator.prMaintainer.onPrDiscovered({
          repositoryId: repository.id,
          ...pullRequest,
        });
        if (error)
          this.auditCycleFailure('orchestrator.pull_request_sweep_failed', {
            repo,
            error: error.message,
          });
      }
    } catch (error: unknown) {
      this.auditCycleFailure('orchestrator.pull_request_sweep_failed', {
        repo,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // One PR-maintenance poll cycle, extracted from the interval so it is callable
  // on its own; the interval only invokes it on a timer.
  // runPrMaintenancePollCycle is one sweep plus the merge back-fill, callable on
  // its own; the interval only invokes it on a timer.
  runPrMaintenancePollCycle(): void {
    this.sweepPullRequests();
  }

  private auditCycleFailure(type: string, fields: Record<string, unknown>): void {
    try {
      this.store.appendEvent({ eventType: type, metadata: fields });
    } catch (error) {
      this.log.error('failed to audit cycle failure', {
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private startBackups(): void {
    if (this.backupInterval || this.config.store.backupIntervalMin < 1) return;
    void this.runBackupCycle('startup');
    this.backupInterval = setInterval(
      () => void this.runBackupCycle('interval'),
      this.config.store.backupIntervalMin * 60_000,
    );
  }

  async runBackupCycle(reason: BackupCycleReason): Promise<void> {
    if (this.backupInFlight) return;
    this.backupInFlight = true;
    this.log.debug('backup tick', { reason });
    try {
      await this.store.backupNow();
      this.store.pruneBackups(this.config.store.backupRetentionCount);
      this.clearBackupRetry();
    } catch (error) {
      const retryScheduled = reason !== 'retry' && this.scheduleBackupRetry();
      this.log.error('scheduled backup failed', {
        reason,
        retry_scheduled: retryScheduled,
        ...backupErrorFields(error, this.store.backupsDir),
      });
    } finally {
      this.backupInFlight = false;
    }
  }

  private scheduleBackupRetry(): boolean {
    if (this.backupRetryTimeout || this.backupRetryDelayMs < 1) return false;
    this.backupRetryTimeout = setTimeout(() => {
      this.backupRetryTimeout = undefined;
      void this.runBackupCycle('retry');
    }, this.backupRetryDelayMs);
    this.backupRetryTimeout.unref?.();
    return true;
  }

  private clearBackupRetry(): void {
    if (!this.backupRetryTimeout) return;
    clearTimeout(this.backupRetryTimeout);
    this.backupRetryTimeout = undefined;
  }
}

function backupErrorFields(error: unknown, fallbackBackupDir: string): Record<string, unknown> {
  const failure = error as Partial<SqliteBackupFailure> | undefined;
  const errorRecord =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const message = error instanceof Error ? error.message : String(error);
  const name =
    error instanceof Error
      ? error.name
      : typeof error === 'object' && error !== null
        ? 'Object'
        : typeof error;
  const code = failure?.code ?? errorRecord.code;
  return {
    error: message,
    error_name: name,
    error_type: typeof error,
    error_code: code,
    backup_dir: failure?.backupDir ?? fallbackBackupDir,
    target_path: failure?.backupTargetPath,
    partial_target_removed: failure?.partialTargetRemoved,
    partial_target_removal_code: failure?.partialTargetRemovalCode,
  };
}
