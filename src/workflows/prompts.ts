import type { AgentKind } from './agents.js';
import type { SandboxTask } from '../orchestrator/sandbox-pool.js';
import { stringPayload } from '../orchestrator/task-payload.js';
import type { PromptSegment, Workflow } from '../types.js';
import { linearImplementationSegments, linearVerifySegments } from './linear/prompts.js';
import { logReviewSegments } from './log-review/prompts.js';
import { fixImplementationSegments, prMaintainerSegments } from './pr/prompts.js';
import { requestRouterSegments } from './router/prompts.js';

// A worker prompt is an ordered list of segments. Exactly one segment per agent
// is `editable` (its key is 'guidance'); an operator may replace that segment's
// text from the dashboard. Every other segment is locked: the identity/context
// header carries the run's dynamic facts, and the output-contract segment holds
// the machine-readable requirements (JSON markers and shapes, branch names,
// commit trailers) the control plane parses. Keeping dynamic values and the
// contract out of the editable segment means a customization can never drop a
// run's context or break downstream parsing.

export function buildWorkerPromptSegments(
  sandboxRunId: string,
  task: SandboxTask,
): PromptSegment[] {
  switch (task.workflow) {
    case 'pr_maintain':
      return prMaintainerSegments(sandboxRunId, task);
    case 'log_review':
      return logReviewSegments(sandboxRunId, task);
    case 'fix_implement':
      return fixImplementationSegments(sandboxRunId, task);
    case 'linear':
      return stringPayload(task, 'role') === 'verify'
        ? linearVerifySegments(sandboxRunId, task)
        : linearImplementationSegments(sandboxRunId, task);
    case 'request_router':
      return requestRouterSegments(sandboxRunId, task);
  }
}

// renderWorkerPrompt substitutes an operator override for the editable segment when
// there is a non-blank one. Locked segments are always rendered as built.
export function renderWorkerPrompt(
  segments: readonly PromptSegment[],
  overrides: Readonly<Record<string, string>> = {},
): string {
  return segments
    .map((seg) => {
      if (seg.editable) {
        const override = overrides[seg.key];
        if (typeof override === 'string' && override.trim().length > 0) return override.trim();
      }
      return seg.text;
    })
    .join('\n\n');
}

export function buildWorkerPrompt(
  sandboxRunId: string,
  task: SandboxTask,
  overrides: Readonly<Record<string, string>> = {},
  repoDocsBlock?: string,
): string {
  const base = renderWorkerPrompt(buildWorkerPromptSegments(sandboxRunId, task), overrides);
  return repoDocsBlock ? `${base}\n${repoDocsBlock}` : base;
}

// buildAgentPromptSegments renders an agent's segments from placeholder values, which
// is what lets the dashboard show them without a run.
export function buildAgentPromptSegments(agent: AgentKind): PromptSegment[] {
  return buildWorkerPromptSegments('sample', {
    workflow: sampleWorkflow(agent),
    payload: samplePayload(agent),
    promptOverrides: {},
  });
}

function sampleWorkflow(agent: AgentKind): Workflow {
  switch (agent) {
    case 'log_reviewer':
      return 'log_review';
    case 'fix_implementer':
      return 'fix_implement';
    case 'pr_maintainer':
      return 'pr_maintain';
    case 'linear_implementer':
    case 'linear_verifier':
      return 'linear';
    case 'request_router':
      return 'request_router';
  }
}

function samplePayload(agent: AgentKind): Record<string, unknown> {
  switch (agent) {
    case 'log_reviewer':
      return { repo: 'owner/repo', services: ['service'], lookback_min: 60, dry_run: true };
    case 'fix_implementer':
      return {
        repo: 'owner/repo',
        service: 'service',
        environment: 'production',
        fingerprint: 'sample-fingerprint',
      };
    case 'pr_maintainer':
      return { repo: 'owner/repo', pr_number: 1 };
    case 'linear_implementer':
      return {
        repo: 'owner/repo',
        fingerprint: 'linear.PROJ-123',
        linear_issue_identifier: 'PROJ-123',
        linear_issue_url: 'https://linear.app/example/issue/PROJ-123/sample-issue',
        prompt_context: '<issue identifier="PROJ-123"><title>Sample issue</title></issue>',
        draft_pr: true,
      };
    case 'linear_verifier':
      return {
        repo: 'owner/repo',
        fingerprint: 'linear.PROJ-123',
        role: 'verify',
        branch: 'agent/linear-PROJ-123-sample',
        linear_pr_url: 'https://github.com/owner/repo/pull/1',
        linear_issue_identifier: 'PROJ-123',
        linear_issue_url: 'https://linear.app/example/issue/PROJ-123/sample-issue',
        prompt_context: '<issue identifier="PROJ-123"><title>Sample issue</title></issue>',
      };
    case 'request_router':
      return {
        request_source: 'discord',
        request_text: 'can someone look at the failing checks on the tenki app',
      };
  }
}
