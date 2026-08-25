import type {
  GitHubDelivery,
  GitHubDeliveryDeps,
  GitHubDeliveryOutcome,
} from '../adapters/github/github-delivery.js';
import { handleGitHubDelivery } from '../adapters/github/github-delivery.js';
import type {
  LinearDelivery,
  LinearDeliveryDeps,
  LinearDeliveryOutcome,
} from '../adapters/linear/linear-delivery.js';
import { handleLinearDelivery } from '../adapters/linear/linear-delivery.js';
import type {
  DiscordCommandOutcome,
  DiscordDeliveryDeps,
} from '../adapters/discord/discord-delivery.js';
import { handleDiscordCommand } from '../adapters/discord/discord-delivery.js';
import type { DiscordCommandInvocation } from '../adapters/discord/discord-interaction.js';
import type { AppConfig } from '../config.js';
import type { Store } from '../store/store.js';
import type { WorkflowType } from '../store/types.js';
import { type OpenWork, listOpenWork, listWorkInConversation } from './open-work.js';
import type { SandboxPool } from './sandbox-pool.js';
import { logReviewTargetsFor } from '../workflows/log-review/log-reviewer.js';

export interface LogReviewAnnouncement {
  announced: string[];
  unknownRepositories: string[];
}

export interface OperatorCommandOutcome {
  accepted: boolean;
  reason?: string;
}

// EngineCommands is every verb an outside surface can ask the engine for. The machines
// are bound here, so no transport has to name one to pass a delivery on.
export interface EngineCommands {
  deliverGitHubWebhook(delivery: GitHubDelivery): Promise<GitHubDeliveryOutcome>;
  deliverLinearWebhook(delivery: LinearDelivery): Promise<LinearDeliveryOutcome>;
  deliverDiscordCommand(invocation: DiscordCommandInvocation): Promise<DiscordCommandOutcome>;
  announceLogReview(scope: LogReviewScope): Promise<LogReviewAnnouncement>;
  listOpenWork(repositoryFullName?: string): OpenWork[];
  listWorkInConversation(conversationKey: string): OpenWork[];
  killSandboxRun(sandboxRunId: string): OperatorCommandOutcome;
  retryWorkflowInstance(
    workflowType: WorkflowType,
    workflowInstanceId: string,
  ): Promise<OperatorCommandOutcome>;
  retryWorkflowVerification(
    workflowType: WorkflowType,
    workflowInstanceId: string,
  ): Promise<OperatorCommandOutcome>;
  dismissWorkflowInstance(
    workflowType: WorkflowType,
    workflowInstanceId: string,
  ): Promise<OperatorCommandOutcome>;
}

// OperatorCommandable is a machine an operator can order around: run this instance
// again, or stop it for good.
export interface OperatorCommandable {
  onOperatorRetry(workflowInstanceId: string): Promise<Error | undefined>;
  onOperatorDismiss(workflowInstanceId: string): Promise<Error | undefined>;
  // Only a workflow that verifies what it implemented can be asked to judge again.
  onOperatorRetryVerification?(workflowInstanceId: string): Promise<Error | undefined>;
}

export interface LogReviewScope {
  repo?: string;
  namespace?: string;
  askedBy?: 'cron' | 'operator';
}

export interface EngineCommandDeps {
  config: AppConfig;
  store: Store;
  // Typed to the seams the commands reach for, not to the engine classes, so what a
  // command can do to a machine is visible here.
  engines: {
    prMaintainer: GitHubDeliveryDeps['prMaintainer'];
    linearImplementer: LinearDeliveryDeps['linearImplementer'];
    logReviewer: GitHubDeliveryDeps['logReviewer'];
  };
  // Hands a ticket to Jardinero where tickets live, so no command has to start work itself.
  delegateTicket: DiscordDeliveryDeps['delegateTicket'];
  // Writes the ticket for work asked for in words, so a command never starts work itself.
  openTicketForRequest: DiscordDeliveryDeps['openTicketForRequest'];
  operatedWorkflows: Partial<Record<WorkflowType, OperatorCommandable>>;
  pool: Pick<SandboxPool, 'isExecuting' | 'abort'>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function createEngineCommands(deps: EngineCommandDeps): EngineCommands {
  const { config, store, engines, env, fetchImpl } = deps;
  return {
    deliverGitHubWebhook: (delivery) =>
      handleGitHubDelivery(
        { config, store, prMaintainer: engines.prMaintainer, logReviewer: engines.logReviewer },
        delivery,
      ),
    deliverLinearWebhook: (delivery) =>
      handleLinearDelivery(
        { config, store, linearImplementer: engines.linearImplementer, env, fetchImpl },
        delivery,
      ),
    deliverDiscordCommand: (invocation) =>
      handleDiscordCommand(
        {
          config,
          store,
          delegateTicket: deps.delegateTicket,
          openTicketForRequest: deps.openTicketForRequest,
          listWorkInConversation: (conversationKey) =>
            listWorkInConversation(store, conversationKey),
          env,
          fetchImpl,
        },
        invocation,
      ),
    listOpenWork: (repositoryFullName) => listOpenWork(store, repositoryFullName),
    listWorkInConversation: (conversationKey) => listWorkInConversation(store, conversationKey),
    announceLogReview: (scope) => announceLogReview(deps, scope),
    killSandboxRun: (sandboxRunId) => killSandboxRun(deps, sandboxRunId),
    retryWorkflowInstance: (workflowType, workflowInstanceId) =>
      retryWorkflowInstance(deps, workflowType, workflowInstanceId),
    retryWorkflowVerification: (workflowType, workflowInstanceId) =>
      retryWorkflowVerification(deps, workflowType, workflowInstanceId),
    dismissWorkflowInstance: (workflowType, workflowInstanceId) =>
      dismissWorkflowInstance(deps, workflowType, workflowInstanceId),
  };
}

function killSandboxRun(deps: EngineCommandDeps, sandboxRunId: string): OperatorCommandOutcome {
  const run = deps.store.getSandboxRun(sandboxRunId);
  if (!run) return { accepted: false, reason: 'unknown_sandbox_run' };
  if (!deps.pool.isExecuting(sandboxRunId)) {
    return { accepted: false, reason: 'sandbox_run_not_executing' };
  }
  deps.pool.abort(sandboxRunId);
  deps.store.appendEvent({
    eventType: 'operator.sandbox_run_killed',
    workflowType: run.workflowType,
    workflowInstanceId: run.workflowInstanceId,
    sandboxRunId,
    metadata: { agent_name: run.agentName },
  });
  return { accepted: true };
}

// retryWorkflowVerification asks a two-step workflow to judge again what it already
// pushed, so a verification that died costs no implementation pass.
async function retryWorkflowVerification(
  deps: EngineCommandDeps,
  workflowType: WorkflowType,
  workflowInstanceId: string,
): Promise<OperatorCommandOutcome> {
  const instance = deps.store.getWorkflowInstance(workflowType, workflowInstanceId);
  if (!instance) return { accepted: false, reason: 'unknown_workflow_instance' };

  const machine = deps.operatedWorkflows[workflowType];
  if (!machine?.onOperatorRetryVerification) {
    return { accepted: false, reason: 'workflow_has_no_verification' };
  }

  deps.store.appendEvent({
    eventType: 'operator.workflow_verification_retried',
    workflowType,
    workflowInstanceId,
    repositoryId: instance.repositoryId ?? undefined,
    metadata: { from_state: instance.workflowState },
  });
  const error = await machine.onOperatorRetryVerification(workflowInstanceId);
  return error ? { accepted: false, reason: error.message } : { accepted: true };
}

async function retryWorkflowInstance(
  deps: EngineCommandDeps,
  workflowType: WorkflowType,
  workflowInstanceId: string,
): Promise<OperatorCommandOutcome> {
  const instance = deps.store.getWorkflowInstance(workflowType, workflowInstanceId);
  if (!instance) return { accepted: false, reason: 'unknown_workflow_instance' };

  const machine = deps.operatedWorkflows[workflowType];
  if (!machine) return { accepted: false, reason: 'workflow_cannot_be_retried' };

  deps.store.appendEvent({
    eventType: 'operator.workflow_instance_retried',
    workflowType,
    workflowInstanceId,
    repositoryId: instance.repositoryId ?? undefined,
    metadata: { from_state: instance.workflowState },
  });
  const error = await machine.onOperatorRetry(workflowInstanceId);
  return error ? { accepted: false, reason: error.message } : { accepted: true };
}

// dismissWorkflowInstance is the other half of the operator's decision on a parked
// instance: not retried, ended.
async function dismissWorkflowInstance(
  deps: EngineCommandDeps,
  workflowType: WorkflowType,
  workflowInstanceId: string,
): Promise<OperatorCommandOutcome> {
  const instance = deps.store.getWorkflowInstance(workflowType, workflowInstanceId);
  if (!instance) return { accepted: false, reason: 'unknown_workflow_instance' };

  const machine = deps.operatedWorkflows[workflowType];
  if (!machine) return { accepted: false, reason: 'workflow_cannot_be_dismissed' };

  const error = await machine.onOperatorDismiss(workflowInstanceId);
  if (!error) {
    deps.store.appendEvent({
      eventType: 'operator.workflow_instance_dismissed',
      workflowType,
      workflowInstanceId,
      repositoryId: instance.repositoryId ?? undefined,
      metadata: { from_state: instance.workflowState },
    });
  }
  return error ? { accepted: false, reason: error.message } : { accepted: true };
}

// announceLogReview announces the same scan the clock would, for the targets the scope
// names: no repo is every target, a repo is every entry of that repo, and both narrow to
// one. A target already being scanned is left alone by the machine.
async function announceLogReview(
  deps: EngineCommandDeps,
  scope: LogReviewScope,
): Promise<LogReviewAnnouncement> {
  const announced: string[] = [];
  const unknown = new Set<string>();

  for (const target of logReviewTargetsFor(deps.config, scope)) {
    const repository = deps.store.findRepositoryByFullName(target.repo);
    if (!repository) {
      unknown.add(target.repo);
      continue;
    }
    const request = deps.store.createRequest({
      requestSource: scope.askedBy ?? 'operator',
      requestText: `log review of ${target.repo}:${target.namespace ?? ''}`,
      repositoryId: repository.id,
      subjectType: 'log_target',
      subjectExternalId: target.namespace,
    });
    const error = await deps.engines.logReviewer.onScheduledScan(
      {
        repositoryId: repository.id,
        serviceName: target.namespace,
        environmentName: target.namespace,
      },
      request.id,
    );
    if (!error) announced.push(`${target.repo}:${target.namespace}`);
  }

  return { announced, unknownRepositories: [...unknown] };
}
