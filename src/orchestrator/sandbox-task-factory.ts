import type { AppConfig } from '../config.js';
import type { Store } from '../store/store.js';
import type { SandboxRun } from '../store/types.js';
import type { Workflow } from '../types.js';
import { linearImplementerPayload, linearVerifierPayload } from '../workflows/linear/payloads.js';
import { logReviewerPayload } from '../workflows/log-review/payloads.js';
import { fixImplementerPayload, prMaintainerPayload } from '../workflows/pr/payloads.js';
import { requestRouterPayload } from '../workflows/router/payloads.js';
import { agentKindForTask } from '../workflows/agents.js';
import type { SandboxTask, SandboxTaskFactory } from './sandbox-pool.js';

export class UnknownAgentError extends Error {
  constructor(agentName: string) {
    super(`no task can be built for agent: ${agentName}`);
    this.name = 'UnknownAgentError';
  }
}

export class MissingInstanceError extends Error {
  constructor(sandboxRun: SandboxRun) {
    super(`instance ${sandboxRun.workflowInstanceId} of ${sandboxRun.workflowType} is gone`);
    this.name = 'MissingInstanceError';
  }
}

// PullRequestStateReader is the one thing the factory asks GitHub: whether the pull
// request a pass would continue is still open.
export interface PullRequestStateReader {
  readPullRequest(
    repositoryFullName: string,
    pullRequestNumber: number,
  ): Promise<{ state: 'open' | 'merged' | 'closed' }>;
}

// InstanceSandboxTaskFactory builds the context of a run out of the instance that asked
// for it: the one place where every agent's payload is assembled.
export class InstanceSandboxTaskFactory implements SandboxTaskFactory {
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
    private readonly github: PullRequestStateReader,
  ) {}

  // Async so that a missing instance or an unknown agent reaches the caller as a
  // rejection, which is what the contract promises.
  async buildTask(sandboxRun: SandboxRun): Promise<SandboxTask> {
    const task = { ...(await this.taskFor(sandboxRun)), promptOverrides: {} };
    return {
      ...task,
      promptOverrides: this.store.resolvePromptOverrides(
        typeof task.payload.repo === 'string' ? task.payload.repo : undefined,
        agentKindForTask(task),
      ),
    };
  }

  private taskFor(sandboxRun: SandboxRun): Promise<Omit<SandboxTask, 'promptOverrides'>> {
    switch (sandboxRun.agentName) {
      case 'RequestRouter':
        return this.requestRouterTask(sandboxRun);
      case 'LinearImplementer':
        return this.linearTask(sandboxRun, 'implement');
      case 'LinearVerifier':
        return this.linearTask(sandboxRun, 'verify');
      case 'FixImplementer':
        return this.fixImplementerTask(sandboxRun);
      case 'PrMaintainer':
        return this.prMaintainerTask(sandboxRun);
      case 'LogReviewer':
        return this.logReviewerTask(sandboxRun);
      default:
        throw new UnknownAgentError(sandboxRun.agentName);
    }
  }

  private async requestRouterTask(
    sandboxRun: SandboxRun,
  ): Promise<Omit<SandboxTask, 'promptOverrides'>> {
    const instance = this.store.getRequest(sandboxRun.workflowInstanceId);
    if (!instance) throw new MissingInstanceError(sandboxRun);
    return { workflow: 'request_router', payload: requestRouterPayload(instance) };
  }

  private async linearTask(
    sandboxRun: SandboxRun,
    seat: 'implement' | 'verify',
  ): Promise<Omit<SandboxTask, 'promptOverrides'>> {
    const instance = this.store.getLinearImplementer(sandboxRun.workflowInstanceId);
    if (!instance) throw new MissingInstanceError(sandboxRun);
    const repositoryFullName = this.repositoryFullName(instance.repositoryId);
    if (seat === 'verify') {
      return {
        workflow: 'linear',
        payload: linearVerifierPayload(instance, repositoryFullName, this.config),
      };
    }
    return {
      workflow: 'linear',
      payload: await this.withOpenPullRequest(
        linearImplementerPayload(instance, repositoryFullName),
        repositoryFullName,
        sandboxRun,
      ),
    };
  }

  private async fixImplementerTask(
    sandboxRun: SandboxRun,
  ): Promise<Omit<SandboxTask, 'promptOverrides'>> {
    const instance = this.store.getFixImplementer(sandboxRun.workflowInstanceId);
    if (!instance) throw new MissingInstanceError(sandboxRun);
    const repositoryFullName = this.repositoryFullName(instance.repositoryId);
    return {
      workflow: 'fix_implement',
      payload: await this.withOpenPullRequest(
        fixImplementerPayload(instance, repositoryFullName),
        repositoryFullName,
        sandboxRun,
      ),
    };
  }

  private async prMaintainerTask(
    sandboxRun: SandboxRun,
  ): Promise<Omit<SandboxTask, 'promptOverrides'>> {
    const instance = this.store.getPrMaintainer(sandboxRun.workflowInstanceId);
    if (!instance) throw new MissingInstanceError(sandboxRun);
    return {
      workflow: 'pr_maintain',
      payload: prMaintainerPayload(
        instance,
        this.repositoryFullName(instance.repositoryId),
        this.config,
      ),
    };
  }

  private async logReviewerTask(
    sandboxRun: SandboxRun,
  ): Promise<Omit<SandboxTask, 'promptOverrides'>> {
    const instance = this.store.getLogReviewer(sandboxRun.workflowInstanceId);
    if (!instance) throw new MissingInstanceError(sandboxRun);
    return {
      workflow: 'log_review',
      payload: logReviewerPayload(
        instance,
        this.repositoryFullName(instance.repositoryId),
        this.config,
      ),
    };
  }

  // withOpenPullRequest drops the pull request a pass was going to continue when GitHub
  // says it ended, so the pass opens its own instead of pushing where nobody reads.
  private async withOpenPullRequest(
    payload: Record<string, unknown>,
    repositoryFullName: string,
    sandboxRun: SandboxRun,
  ): Promise<Record<string, unknown>> {
    const pullRequestNumber = payload.pr_number;
    if (typeof pullRequestNumber !== 'number') return payload;

    // A read that fails leaves it in: a blip must not make a pass open a second one.
    let state: 'open' | 'merged' | 'closed';
    try {
      state = (await this.github.readPullRequest(repositoryFullName, pullRequestNumber)).state;
    } catch {
      return payload;
    }
    if (state === 'open') return payload;

    this.store.appendEvent({
      eventType: 'workflow.pull_request_dropped',
      workflowType: sandboxRun.workflowType,
      workflowInstanceId: sandboxRun.workflowInstanceId,
      sandboxRunId: sandboxRun.id,
      metadata: { pull_request_number: pullRequestNumber, pull_request_state: state },
    });
    const { pr_number: _dropped, ...rest } = payload;
    return rest;
  }

  // Answers the repository name an agent is given, refusing when the row it
  // points at is gone.
  private repositoryFullName(repositoryId: string): string {
    const repository = this.store.getRepositoryById(repositoryId);
    if (!repository) throw new Error(`repository ${repositoryId} is gone`);
    return repository.fullName;
  }
}

export type { SandboxTask, Workflow };
