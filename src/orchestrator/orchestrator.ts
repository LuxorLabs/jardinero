import { type AppConfig, workflowConcurrencies } from '../config.js';
import { InMemoryLocker } from '../platform/locker.js';
import { minutes } from '../platform/time.js';
import type { Store } from '../store/store.js';
import type { OperatorCommandable } from './engine-commands.js';
import type { WorkflowType } from '../store/types.js';
import type { SandboxRunner } from './sandbox-pool.js';
import { recoverOpenInstancesAfterBoot } from './boot-recovery.js';
import { PeriodicCheckTimer } from './periodic-check-timer.js';
import { createDiscordWorkAnnouncer } from '../adapters/discord/discord-announcer.js';
import { SandboxPool } from './sandbox-pool.js';
import { InstanceSandboxRunOutcomeReporter } from './sandbox-run-outcome-reporter.js';
import { InstanceSandboxTaskFactory } from './sandbox-task-factory.js';
import {
  FixImplementerStateEngine,
  type GitHubImplementationPrReader,
} from './state-machines/fix-implementer/service.js';
import { LinearImplementerStateEngine } from './state-machines/linear-implementer/service.js';
import { LogReviewerStateEngine } from './state-machines/log-reviewer/service.js';
import type { GitHubWriter } from './state-machines/linear-implementer/service.js';
import type { GitHubCommentWriter, GitHubReader } from './state-machines/pr-maintainer/service.js';
import { PrMaintainerStateEngine } from './state-machines/pr-maintainer/service.js';
import { RequestRouterStateEngine } from './state-machines/request-router/service.js';
import type { WorkflowEngines } from './workflow-engines.js';

export interface OrchestratorDeps {
  config: AppConfig;
  store: Store;
  runner: SandboxRunner;
  github: GitHubReader & GitHubWriter & GitHubImplementationPrReader & GitHubCommentWriter;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

// How often the clock ticks. The cadence of each state is its own, and comes from
// `checkWaitMs`.
const TICK_MS = 10_000;

// Orchestrator builds the five state machines and everything that moves them: the pool
// that runs their agents, the clock that revisits them, and the boot recovery. A
// transport only ever needs the machines.
export class Orchestrator implements WorkflowEngines {
  readonly requestRouter: RequestRouterStateEngine;
  readonly linearImplementer: LinearImplementerStateEngine;
  readonly fixImplementer: FixImplementerStateEngine;
  readonly prMaintainer: PrMaintainerStateEngine;
  readonly logReviewer: LogReviewerStateEngine;
  readonly pool: SandboxPool;
  readonly operatedWorkflows: Partial<Record<WorkflowType, OperatorCommandable>>;

  private readonly store: Store;
  private readonly timer: PeriodicCheckTimer;

  constructor(deps: OrchestratorDeps) {
    const { config, store, runner, github } = deps;
    this.store = store;
    const locker = new InMemoryLocker();
    const reporter = new InstanceSandboxRunOutcomeReporter(store, config, () => this);
    this.pool = new SandboxPool(
      store,
      runner,
      new InstanceSandboxTaskFactory(store, config, github),
      reporter,
      {
        maxConcurrentSandboxes: config.sandboxes.maxConcurrentRuns,
        maxConcurrentSandboxesByWorkflow: workflowConcurrencies(config),
        maxWallClockMs: minutes(config.sandboxes.maxWallClockMin),
      },
    );

    const announcer = createDiscordWorkAnnouncer({
      config,
      store,
      env: deps.env,
      fetchImpl: deps.fetchImpl,
    });
    const pool = this.pool;
    this.requestRouter = new RequestRouterStateEngine(
      store,
      pool,
      locker,
      { checkWaitMs: config.workflows.requestRouter.checkWaitMs },
      announcer,
    );
    this.linearImplementer = new LinearImplementerStateEngine(
      store,
      pool,
      github,
      locker,
      {
        maxIterations: config.workflows.linearImplementer.maxIterations,
        checkWaitMs: config.workflows.linearImplementer.checkWaitMs,
      },
      announcer,
    );
    this.fixImplementer = new FixImplementerStateEngine(
      store,
      pool,
      github,
      locker,
      {
        maxIterations: config.workflows.fixImplementer.maxIterations,
        checkWaitMs: config.workflows.fixImplementer.checkWaitMs,
      },
      announcer,
    );
    this.prMaintainer = new PrMaintainerStateEngine(
      store,
      pool,
      github,
      locker,
      {
        maxAttempts: config.workflows.prMaintainer.maxPushAttempts,
        maxRepliesPerThread: config.workflows.prMaintainer.maxRepliesPerThread,
        agentPullRequest: { branchPrefix: config.workflows.prMaintainer.pollBranchPrefix },
        checkWaitMs: config.workflows.prMaintainer.checkWaitMs,
      },
      announcer,
    );
    this.logReviewer = new LogReviewerStateEngine(store, pool, locker, {
      scanWindowMs: config.workflows.logReviewer.lookbackMin * 60_000,
      checkWaitMs: config.workflows.logReviewer.checkWaitMs,
    });

    this.operatedWorkflows = {
      linear_implementer: this.linearImplementer,
      fix_implementer: this.fixImplementer,
      pr_maintainer: this.prMaintainer,
    };

    this.timer = new PeriodicCheckTimer(store, this, { tickMs: TICK_MS });
  }

  // start recovers whatever the last process left open and then starts the clock.
  // Called once, after every transport is built and before any can be reached.
  async start(): Promise<void> {
    await recoverOpenInstancesAfterBoot(this.store, this);
    this.timer.start();
  }

  // stop stops the clock and lets go of whatever is in flight, in that order, so no
  // tick starts work while the pool is draining.
  async stop(): Promise<void> {
    this.timer.stop();
    await this.pool.stop();
  }
}
