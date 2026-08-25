import { logger } from '../platform/logger.js';
import type { Store } from '../store/store.js';
import type { WorkflowType } from '../store/types.js';
import type { WorkflowEngines } from './workflow-engines.js';

const log = logger.child('boot-recovery');

interface OpenInstances {
  workflowType: WorkflowType;
  workflowInstanceIds: string[];
  recover(workflowInstanceId: string): Promise<Error | undefined>;
}

// recoverOpenInstancesAfterBoot hands every open instance to its machine once, before
// any transport can be reached. Each machine decides what a restart means for the state
// it was left in.
export async function recoverOpenInstancesAfterBoot(
  store: Store,
  engines: WorkflowEngines,
): Promise<void> {
  for (const open of listOpenInstances(store, engines)) {
    await recoverEachInstance(open);
  }
}

function listOpenInstances(store: Store, engines: WorkflowEngines): OpenInstances[] {
  const { requestRouter, linearImplementer, fixImplementer, prMaintainer, logReviewer } = engines;
  return [
    {
      workflowType: 'request_router',
      workflowInstanceIds: idsOf(store.listOpenRequests()),
      recover: (id) => requestRouter.onSystemRecovery(id),
    },
    {
      workflowType: 'linear_implementer',
      workflowInstanceIds: idsOf(store.listOpenLinearImplementers()),
      recover: (id) => linearImplementer.onSystemRecovery(id),
    },
    {
      workflowType: 'fix_implementer',
      workflowInstanceIds: idsOf(store.listOpenFixImplementers()),
      recover: (id) => fixImplementer.onSystemRecovery(id),
    },
    {
      workflowType: 'pr_maintainer',
      workflowInstanceIds: idsOf(store.listOpenPrMaintainers()),
      recover: (id) => prMaintainer.onSystemRecovery(id),
    },
    {
      workflowType: 'log_reviewer',
      workflowInstanceIds: idsOf(store.listOpenLogReviewers()),
      recover: (id) => logReviewer.onSystemRecovery(id),
    },
  ];
}

// recoverEachInstance carries on past a failure, so one machine cannot stop the rest of
// the system from coming up.
async function recoverEachInstance(open: OpenInstances): Promise<void> {
  for (const workflowInstanceId of open.workflowInstanceIds) {
    try {
      const error = await open.recover(workflowInstanceId);
      if (error) logFailure(open.workflowType, workflowInstanceId, error);
    } catch (error) {
      logFailure(open.workflowType, workflowInstanceId, error);
    }
  }
}

function logFailure(workflowType: WorkflowType, workflowInstanceId: string, error: unknown): void {
  log.error('boot recovery failed', {
    workflow_type: workflowType,
    workflow_instance_id: workflowInstanceId,
    reason: error instanceof Error ? error.message : String(error),
  });
}

function idsOf(instances: Array<{ id: string }>): string[] {
  return instances.map((instance) => instance.id);
}
