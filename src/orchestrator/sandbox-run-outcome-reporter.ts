import { logger } from '../platform/logger.js';
import type { Store } from '../store/store.js';
import type { SubjectType } from '../store/types.js';
import type { AppConfig } from '../config.js';
import type { ImplementationHandoff, WorkerResult } from '../types.js';
import { parseRouting } from '../workflows/router/routing.js';
import type { SandboxRunOutcomeReporter } from './sandbox-pool.js';
import type { FixImplementerStateEngineInterface } from './state-machines/fix-implementer/service.js';
import type { LinearImplementerStateEngineInterface } from './state-machines/linear-implementer/service.js';
import type { LogReviewerStateEngineInterface } from './state-machines/log-reviewer/service.js';
import type { PrMaintainerStateEngineInterface } from './state-machines/pr-maintainer/service.js';
import type { RequestRouterStateEngineInterface } from './state-machines/request-router/service.js';

// OutcomeReportingEngines is the five machines a run can belong to, narrowed to the two
// entry points an outcome reaches.
export interface OutcomeReportingEngines {
  requestRouter: Pick<
    RequestRouterStateEngineInterface,
    'onSandboxRunSucceeded' | 'onSandboxRunFailed'
  >;
  linearImplementer: Pick<
    LinearImplementerStateEngineInterface,
    'onSandboxRunSucceeded' | 'onSandboxRunFailed'
  >;
  fixImplementer: Pick<
    FixImplementerStateEngineInterface,
    'onSandboxRunSucceeded' | 'onSandboxRunFailed' | 'onFindingReported'
  >;
  prMaintainer: Pick<
    PrMaintainerStateEngineInterface,
    'onSandboxRunSucceeded' | 'onSandboxRunFailed'
  >;
  logReviewer: Pick<
    LogReviewerStateEngineInterface,
    'onSandboxRunSucceeded' | 'onSandboxRunFailed'
  >;
}

// InstanceSandboxRunOutcomeReporter reads an agent's result into the outcome its
// machine expects, and hands it over.
export class InstanceSandboxRunOutcomeReporter implements SandboxRunOutcomeReporter {
  private readonly log = logger.child('run-outcome');

  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
    // A getter because the pool and the machines point at each other.
    private readonly engines: () => OutcomeReportingEngines,
  ) {}

  async reportSucceeded(sandboxRunId: string, result: WorkerResult): Promise<void> {
    const sandboxRun = this.store.getSandboxRun(sandboxRunId);
    if (!sandboxRun) return;
    switch (sandboxRun.workflowType) {
      case 'request_router':
        return this.report(
          sandboxRunId,
          this.engines().requestRouter.onSandboxRunSucceeded(sandboxRunId, this.routingOf(result)),
        );
      case 'linear_implementer':
        return this.report(
          sandboxRunId,
          this.engines().linearImplementer.onSandboxRunSucceeded(sandboxRunId, {
            ...pullRequestOf(result),
            ...verdictOf(result),
          }),
        );
      case 'fix_implementer':
        return this.report(
          sandboxRunId,
          this.engines().fixImplementer.onSandboxRunSucceeded(sandboxRunId, {
            ...pullRequestOf(result),
            ...discardOf(result),
          }),
        );
      case 'pr_maintainer':
        return this.report(
          sandboxRunId,
          this.engines().prMaintainer.onSandboxRunSucceeded(sandboxRunId),
        );
      case 'log_reviewer':
        await this.report(
          sandboxRunId,
          this.engines().logReviewer.onSandboxRunSucceeded(sandboxRunId, {
            findingCount: result.implementationHandoffs?.length ?? 0,
          }),
        );
        return await this.openFixes(sandboxRun.workflowInstanceId, this.findingsOf(result));
    }
  }

  // findingsOf reads the handoffs a scan is willing to hand over: ready for
  // implementation, confident enough to be worth a sandbox, and not a dry run preview.
  // The cap is what stops one noisy scan from opening a fix for everything it saw.
  private findingsOf(result: WorkerResult): ImplementationHandoff[] {
    const logReview = this.config.workflows.logReviewer;
    return (result.implementationHandoffs ?? [])
      .filter((handoff) => handoff.readyForImplementation)
      .filter((handoff) => !handoff.dispatchBlockedByDryRun && !logReview.dryRun)
      .filter((handoff) => handoff.confidence >= logReview.investigationConfidenceThreshold)
      .slice(0, this.config.workflows.fixImplementer.maxHandoffsPerRun);
  }

  // openFixes hands each finding to the FixImplementer, which is what makes a scan
  // produce work instead of a count.
  private async openFixes(logReviewerId: string, findings: ImplementationHandoff[]): Promise<void> {
    for (const handoff of findings) {
      const repository = this.store.findRepositoryByFullName(handoff.repo);
      if (!repository) {
        this.log.warn('finding names a repository we do not know', {
          repo: handoff.repo,
          fingerprint: handoff.fingerprint,
        });
        continue;
      }
      const error = await this.engines().fixImplementer.onFindingReported(
        {
          repositoryId: repository.id,
          findingFingerprint: handoff.fingerprint,
          serviceName: handoff.service,
          environmentName: handoff.environment,
          findingEvidence: JSON.stringify(handoff.raw),
        },
        logReviewerId,
      );
      if (error) {
        this.log.warn('the fix implementer refused a finding', {
          fingerprint: handoff.fingerprint,
          error: error.message,
        });
      }
    }
  }

  async reportFailed(sandboxRunId: string): Promise<void> {
    const sandboxRun = this.store.getSandboxRun(sandboxRunId);
    if (!sandboxRun) return;
    switch (sandboxRun.workflowType) {
      case 'request_router':
        return this.report(
          sandboxRunId,
          this.engines().requestRouter.onSandboxRunFailed(sandboxRunId),
        );
      case 'linear_implementer':
        return this.report(
          sandboxRunId,
          this.engines().linearImplementer.onSandboxRunFailed(sandboxRunId),
        );
      case 'fix_implementer':
        return this.report(
          sandboxRunId,
          this.engines().fixImplementer.onSandboxRunFailed(sandboxRunId),
        );
      case 'pr_maintainer':
        return this.report(
          sandboxRunId,
          this.engines().prMaintainer.onSandboxRunFailed(sandboxRunId),
        );
      case 'log_reviewer':
        return this.report(
          sandboxRunId,
          this.engines().logReviewer.onSandboxRunFailed(sandboxRunId),
        );
    }
  }

  // Reads the routing out of a RequestRouter result, resolving the repository the
  // agent named into the id the machine stores.
  private routingOf(result: WorkerResult): {
    subjectType?: SubjectType;
    subjectExternalId?: string;
    repositoryId?: string;
    resolutionNote?: string;
  } {
    const { routing, rejectionReason } = parseRouting(result.summary);
    if (!routing) return { resolutionNote: rejectionReason ?? 'no_routing_answer' };
    const repository = routing.repositoryFullName
      ? this.store.findRepositoryByFullName(routing.repositoryFullName)
      : undefined;
    return {
      ...(routing.subjectType ? { subjectType: routing.subjectType } : {}),
      ...(routing.subjectExternalId ? { subjectExternalId: routing.subjectExternalId } : {}),
      ...(repository ? { repositoryId: repository.id } : {}),
      ...(routing.resolutionNote ? { resolutionNote: routing.resolutionNote } : {}),
    };
  }

  // Awaits one report and logs the failure the machine answered with. Dropping it
  // is safe: the periodic check reaches the instance again.
  private async report(sandboxRunId: string, reporting: Promise<Error | undefined>): Promise<void> {
    const error = await reporting;
    if (!error) return;
    this.log.error('the machine refused the outcome', {
      sandbox_run_id: sandboxRunId,
      reason: error.message,
    });
  }
}

const _REQUESTED_ACTIONS = new Set<string>([
  'implement',
  'create_ticket',
  'adopt',
  'comment',
  'scan',
  'retry',
  'pause',
  'resume',
  'kill',
]);

// pullRequestOf parses the number out of the pull request url the agent reported.
function pullRequestOf(result: WorkerResult): { pullRequestNumber?: number } {
  const number = pullRequestNumberFrom(result.openedPrUrl);
  if (number === undefined) return {};
  return {
    pullRequestNumber: number,
  };
}

function verdictOf(result: WorkerResult): {
  verdict?: 'accept' | 'reject';
  verifierIssues?: string;
  hasVerdict?: boolean;
} {
  const verification = result.linearVerification;
  if (!verification) return { hasVerdict: false };
  return {
    verdict: verification.verdict,
    hasVerdict: true,
    ...(verification.issues.length > 0 ? { verifierIssues: verification.issues.join('\n') } : {}),
  };
}

function discardOf(result: WorkerResult): { discardReason?: string } {
  const reason = result.noPrOutcome?.reason;
  return reason === undefined ? {} : { discardReason: reason };
}

function pullRequestNumberFrom(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const match = /\/pull\/(\d+)(?:$|[/?#])/.exec(url);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
