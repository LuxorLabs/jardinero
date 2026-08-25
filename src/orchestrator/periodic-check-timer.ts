import { logger } from '../platform/logger.js';
import type { Store } from '../store/store.js';
import type { WorkflowType } from '../store/types.js';
import type { WorkflowEngines } from './workflow-engines.js';

export interface PeriodicCheckTimerConfig {
  // The beat is even and knows nothing about cadences: which instances are due
  // is decided by each state against its own wait.
  tickMs: number;
}

interface DueInstances {
  workflowType: WorkflowType;
  workflowInstanceIds: string[];
  check(workflowInstanceId: string): Promise<Error | undefined>;
}

// PeriodicCheckTimer ticks and asks each machine to look at the instances that are due.
// Without it a state that waits on the outside world would never move.
export class PeriodicCheckTimer {
  private timer: NodeJS.Timeout | undefined;
  private checking = false;
  private readonly log = logger.child('periodic-check');

  constructor(
    private readonly store: Store,
    private readonly engines: WorkflowEngines,
    private readonly config: PeriodicCheckTimerConfig,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkInstancesDueNow();
    }, this.config.tickMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // Runs one beat over the five machines. A beat that outlives its interval skips
  // the next one rather than piling up on it.
  async checkInstancesDueNow(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const due of this.listDueInstances()) {
        await this.checkEachInstance(due);
      }
    } finally {
      this.checking = false;
    }
  }

  private listDueInstances(): DueInstances[] {
    const { requestRouter, linearImplementer, fixImplementer, prMaintainer, logReviewer } =
      this.engines;
    return [
      {
        workflowType: 'request_router',
        workflowInstanceIds: idsOf(this.store.listRequestsDue(requestRouter.config.checkWaitMs)),
        check: (id) => requestRouter.onPeriodicCheck(id),
      },
      {
        workflowType: 'linear_implementer',
        workflowInstanceIds: idsOf(
          this.store.listLinearImplementersDue(linearImplementer.config.checkWaitMs),
        ),
        check: (id) => linearImplementer.onPeriodicCheck(id),
      },
      {
        workflowType: 'fix_implementer',
        workflowInstanceIds: idsOf(
          this.store.listFixImplementersDue(fixImplementer.config.checkWaitMs),
        ),
        check: (id) => fixImplementer.onPeriodicCheck(id),
      },
      {
        workflowType: 'pr_maintainer',
        workflowInstanceIds: idsOf(
          this.store.listPrMaintainersDue(prMaintainer.config.checkWaitMs),
        ),
        check: (id) => prMaintainer.onPeriodicCheck(id),
      },
      {
        workflowType: 'log_reviewer',
        workflowInstanceIds: idsOf(this.store.listLogReviewersDue(logReviewer.config.checkWaitMs)),
        check: (id) => logReviewer.onPeriodicCheck(id),
      },
    ];
  }

  // Hands every due instance of one machine over, carrying on past a failure so a
  // single stuck subject cannot freeze the ones behind it.
  private async checkEachInstance(due: DueInstances): Promise<void> {
    for (const workflowInstanceId of due.workflowInstanceIds) {
      try {
        const error = await due.check(workflowInstanceId);
        if (error) this.logFailure(due.workflowType, workflowInstanceId, error);
      } catch (error) {
        this.logFailure(due.workflowType, workflowInstanceId, error);
      }
    }
  }

  private logFailure(workflowType: WorkflowType, workflowInstanceId: string, error: unknown): void {
    this.log.error('periodic check failed', {
      workflow_type: workflowType,
      workflow_instance_id: workflowInstanceId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function idsOf(instances: Array<{ id: string }>): string[] {
  return instances.map((instance) => instance.id);
}
