import { setTimeout as delay } from 'node:timers/promises';

import { buildWorkerPrompt } from '../../workflows/prompts.js';
import type { WorkerResult } from '../../types.js';
import type { SandboxRunContext, SandboxRunner } from '../sandbox-pool.js';

export class MockWorkerRunner implements SandboxRunner {
  async run(context: SandboxRunContext): Promise<WorkerResult> {
    const prompt = buildWorkerPrompt(context.sandboxRun.id, context.task);
    await context.publishEvent({
      type: 'sandbox.started',
      message: 'Mock worker started',
      data: { workflow: context.task.workflow },
    });
    await context.writeSandboxRunArtifact('prompt.txt', prompt);

    await delay(25, undefined, { signal: context.signal });

    if (context.task.workflow === 'log_review') {
      const implementationHandoffs = Array.isArray(
        context.task.payload.mock_implementation_handoffs,
      )
        ? context.task.payload.mock_implementation_handoffs
        : [];
      const report = {
        dry_run: context.task.payload.dry_run ?? true,
        services: context.task.payload.services,
        candidates: [],
        implementation_handoffs: implementationHandoffs,
        note: 'Mock runner did not query Grafana. A real runner is required for live log review.',
      };
      const artifact = await context.writeSandboxRunArtifact(
        'triage-report.json',
        JSON.stringify(report, null, 2),
      );
      await context.publishEvent({
        type: 'agent.scan_finished',
        message: 'Mock log review completed without candidates',
        data: { artifact },
      });
      return {
        status: 'succeeded',
        costUsd: 0,
        summary: 'Mock log review completed with zero candidates.',
        implementationHandoffs: implementationHandoffs as WorkerResult['implementationHandoffs'],
        artifacts: { triage_report: artifact },
      };
    }

    if (context.task.workflow === 'fix_implement') {
      const openedPrUrl =
        typeof context.task.payload.mock_opened_pr_url === 'string'
          ? context.task.payload.mock_opened_pr_url
          : undefined;
      const noPrOutcome =
        openedPrUrl === undefined
          ? {
              outcome: 'no_pr' as const,
              reason: 'false_positive' as const,
              evidence: ['Mock fix implementation did not make GitHub writes.'],
              recommendedFollowup: 'Use a real runner for live implementation.',
              raw: {
                outcome: 'no_pr',
                reason: 'false_positive',
                evidence: ['Mock fix implementation did not make GitHub writes.'],
                recommended_followup: 'Use a real runner for live implementation.',
              },
            }
          : undefined;
      await context.publishEvent({
        type: 'agent.pass_finished',
        message: 'Mock fix implementation completed',
        data: {
          repo: context.task.payload.repo,
          fingerprint: context.task.payload.fingerprint,
          no_pr_reason: noPrOutcome?.reason,
        },
      });
      return {
        status: openedPrUrl ? 'succeeded' : 'skipped',
        costUsd: 0,
        summary: openedPrUrl
          ? 'Mock fix implementation completed with a pull request.'
          : 'Mock fix implementation skipped without a pull request.',
        openedPrUrl,
        noPrOutcome,
      };
    }

    if (context.task.workflow === 'pr_maintain') {
      await context.publishEvent({
        type: 'agent.pass_finished',
        message: 'Mock PR maintenance pass completed',
        data: {
          repo: context.task.payload.repo,
          pr_number: context.task.payload.pr_number,
        },
      });
      return {
        status: 'succeeded',
        costUsd: 0,
        summary: 'Mock PR maintenance pass completed. No GitHub writes were made.',
      };
    }

    if (context.task.payload.role === 'verify') {
      return this.runLinearVerify(context);
    }

    // linear implement: mirrors the fix_implement mock. A test or smoke run can
    // force the PR-success path via the `mock_opened_pr_url` payload key; a
    // corrective pass echoes the PR it continues; otherwise the run ends as an
    // accepted no-PR outcome.
    const openedPrUrl =
      typeof context.task.payload.mock_opened_pr_url === 'string'
        ? context.task.payload.mock_opened_pr_url
        : typeof context.task.payload.linear_pr_url === 'string'
          ? context.task.payload.linear_pr_url
          : undefined;
    const noPrOutcome =
      openedPrUrl === undefined
        ? {
            outcome: 'no_pr' as const,
            reason: 'insufficient_evidence' as const,
            evidence: ['Mock linear implementation did not make GitHub writes.'],
            recommendedFollowup: 'Use a real runner for live implementation.',
            raw: {
              outcome: 'no_pr',
              reason: 'insufficient_evidence',
              evidence: ['Mock linear implementation did not make GitHub writes.'],
              recommended_followup: 'Use a real runner for live implementation.',
            },
          }
        : undefined;
    await context.publishEvent({
      type: 'agent.pass_finished',
      message: 'Mock linear implementation completed',
      data: {
        repo: context.task.payload.repo,
        issue: context.task.payload.linear_issue_identifier,
        no_pr_reason: noPrOutcome?.reason,
      },
    });
    return {
      status: openedPrUrl ? 'succeeded' : 'skipped',
      costUsd: 0,
      summary: openedPrUrl
        ? 'Mock linear implementation completed with a pull request.'
        : 'Mock linear implementation skipped without a pull request.',
      openedPrUrl,
      noPrOutcome,
    };
  }

  // Accepting verdict by default so the loop converges without a live agent; a
  // test overrides via `mock_linear_verification` to exercise reject/iterate.
  // The literal string 'missing' returns a succeeded run without a verdict so a
  // test can exercise the coordinator's transient-retry path.
  private async runLinearVerify(context: SandboxRunContext): Promise<WorkerResult> {
    if (context.task.payload.mock_linear_verification === 'missing') {
      await context.publishEvent({
        type: 'agent.pass_finished',
        message: 'Mock linear verification completed without a verdict',
        data: { issue: context.task.payload.linear_issue_identifier },
      });
      return {
        status: 'succeeded',
        costUsd: 0,
        summary: 'Mock linear verification produced no verdict.',
      };
    }
    const override =
      typeof context.task.payload.mock_linear_verification === 'object' &&
      context.task.payload.mock_linear_verification !== null
        ? (context.task.payload.mock_linear_verification as WorkerResult['linearVerification'])
        : undefined;
    const linearVerification = override ?? {
      verdict: 'accept' as const,
      criteria: [{ text: 'Mock criterion', status: 'passed' as const }],
      issues: [],
      followedProcedures: true,
      raw: {},
    };
    await context.publishEvent({
      type: 'agent.pass_finished',
      message: `Mock linear verification completed: ${linearVerification?.verdict}`,
      data: {
        issue: context.task.payload.linear_issue_identifier,
        verdict: linearVerification?.verdict,
      },
    });
    return {
      status: 'succeeded',
      costUsd: 0,
      summary: 'Mock linear verification completed.',
      linearVerification,
    };
  }
}
