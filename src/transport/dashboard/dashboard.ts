import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROMPT_GLOBAL_REPO,
  AGENT_KINDS,
  type AgentKind,
  MAX_PROMPT_LENGTH,
} from '../../workflows/agents.js';
import { type AppConfig, configuredRepositoryNames, workflowConcurrencies } from '../../config.js';
import { nowMs } from '../../platform/time.js';
import { REPLY_CAP_REACHED_NOTE } from '../../orchestrator/state-machines/execution.js';
import {
  ATTENTION_STATES,
  AWAITING_A_PERSON_STATES,
  workflowStateTone,
} from '../../store/types.js';
import type {
  EventLogEntry,
  OurPullRequest,
  StateArrivalBucket,
  RequestSummary,
  SandboxRun,
  WorkflowInstanceSummary,
} from '../../store/types.js';
import type {
  PromptWire,
  PromptsResponse,
  DashboardSnapshot,
  EventListResponse,
  EventRow,
  MetricSeriesPoint,
  OverviewMetricKey,
  OverviewMetricsWindow,
  OverviewResponse,
  OverviewWindowKey,
  PullRequestListResponse,
  PullRequestRow,
  RequestListResponse,
  RequestOutcome,
  RequestRow,
  RequestSource,
  SandboxRunDetailResponse,
  SandboxRunRow,
  WorkflowInstanceDetailResponse,
  WorkflowInstanceListResponse,
  WorkflowInstanceRow,
  WorkflowType,
} from './dashboard-api-types.js';
import { buildAgentPromptSegments } from '../../workflows/prompts.js';
import { readJsonObjectBody } from '../request.js';
import type { ApiContext } from '../context.js';
import { headerValue } from '../request.js';
import { sendHtml, sendJson } from '../respond.js';
import { resolveAppVersion } from '../../platform/version.js';

// OPERATED_WORKFLOW_TYPES leaves the router out: it is the door every ask comes
// through, and an ask is read in Requests, which shows what became of it.
const OPERATED_WORKFLOW_TYPES: WorkflowType[] = [
  'linear_implementer',
  'fix_implementer',
  'log_reviewer',
  'pr_maintainer',
];
// WORKFLOW_TYPE_ORDER is the order the workflows are shown in, which follows the life of a
// request: routed, implemented, fixed, scanned, maintained.
const WORKFLOW_TYPE_ORDER: WorkflowType[] = [
  'request_router',
  'linear_implementer',
  'fix_implementer',
  'log_reviewer',
  'pr_maintainer',
];
// METRIC_ARRIVAL_STATES says what the two metrics counted off transitions count.
const METRIC_ARRIVAL_STATES: Record<'items_triaged' | 'incidents_handled', readonly string[]> = {
  items_triaged: ['lr_done'],
  incidents_handled: ['fi_done'],
};
const METRIC_STATES = Object.values(METRIC_ARRIVAL_STATES).flat();
const PULL_REQUEST_FINISHED_STATES: readonly string[] = ['prm_merged', 'prm_closed'];
const EVENT_FAMILIES: readonly string[] = [
  'workflow',
  'sandbox',
  'agent',
  'orchestrator',
  'operator',
];
const REQUEST_SOURCES: readonly RequestSource[] = [
  'discord',
  'github',
  'linear',
  'cron',
  'operator',
];
const SHARED_INSTANCE_COLUMNS: readonly string[] = [
  'id',
  'workflow_state',
  'repository_id',
  'sandbox_run_id',
  'last_state_checked_at',
  'state_changed_at',
  'created_at',
  'updated_at',
];
const WORKFLOW_STATE_LABELS: Record<string, string> = {
  rr_pending: 'not read',
  rr_routing: 'routing',
  rr_resolved: 'handed over',
  rr_unresolvable: 'unresolvable',
  li_pending: 'starting',
  li_implementing: 'writing changes',
  li_verifying: 'checking changes',
  li_waiting_pr: 'waiting for review',
  li_needs_human: 'needs a person',
  li_done: 'done',
  li_abandoned: 'abandoned',
  li_dismissed: 'stopped by a person',
  fi_pending: 'starting',
  fi_implementing: 'writing fix',
  fi_verifying: 'checking fix',
  fi_waiting_pr: 'waiting for review',
  fi_needs_human: 'needs a person',
  fi_discarded: 'discarded',
  fi_done: 'done',
  fi_abandoned: 'closed unmerged',
  fi_dismissed: 'stopped by a person',
  lr_pending: 'starting scan',
  lr_working: 'reading logs',
  lr_done: 'done',
  lr_failed: 'failed',
  prm_pending: 'starting',
  prm_working: 'working',
  prm_waiting: 'waiting on PR',
  prm_attempts_exhausted: 'gave up',
  prm_merged: 'merged',
  prm_closed: 'closed unmerged',
  prm_dismissed: 'stopped by a person',
};
const OVERVIEW_METRICS = [
  'items_triaged',
  'prs_opened',
  'prs_merged',
  'incidents_handled',
] as const satisfies readonly OverviewMetricKey[];
const OVERVIEW_WINDOWS = {
  '24h': { durationMs: 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000, buckets: 24 },
  '7d': { durationMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000, buckets: 7 },
  '30d': { durationMs: 30 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000, buckets: 30 },
} as const;
// Double Linear's ~60s HMAC replay tolerance so a delivery id stays remembered
// past any window in which Linear would retry the same delivery.

export async function handleDashboard(
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const method = request.method ?? 'GET';

  // The SPA's hashed JS/CSS bundles. These carry no sensitive data, so they can use
  // immutable caching.
  if (method === 'GET' && url.pathname.startsWith('/dashboard/assets/')) {
    serveDashboardAsset(response, url.pathname);
    return;
  }

  if (method === 'GET' && DASHBOARD_PUBLIC_FILES.has(dashboardPublicFileName(url.pathname))) {
    serveDashboardPublicFile(response, url.pathname);
    return;
  }

  if (url.pathname.startsWith('/dashboard/api/')) {
    await handleDashboardApi(context, request, response, url);
    return;
  }

  const activeTab = dashboardTabFromPath(url.pathname);
  if (method === 'GET' && activeTab) {
    sendHtml(response, 200, renderSpaShell(activeTab));
    return;
  }

  sendHtml(response, 404, renderDashboardNotFound());
}

async function handleDashboardApi(
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  if (request.method === 'GET' && url.pathname === '/dashboard/api/session') {
    sendJson(response, 200, dashboardSnapshot(context));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/dashboard/api/overview') {
    sendJson(response, 200, dashboardOverview(context, url.searchParams));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/dashboard/api/workflow-instances') {
    sendJson(response, 200, dashboardWorkflowInstances(context, url.searchParams));
    return;
  }

  const instanceMatch = /^\/dashboard\/api\/workflow-instances\/([^/]+)\/([^/]+)$/.exec(
    url.pathname,
  );
  if (request.method === 'GET' && instanceMatch) {
    const detail = dashboardWorkflowInstanceDetail(
      context,
      instanceMatch[1] as WorkflowType,
      instanceMatch[2],
    );
    if (!detail) {
      sendJson(response, 404, { error: 'workflow_instance_not_found' });
      return;
    }
    sendJson(response, 200, detail);
    return;
  }

  const retryMatch = /^\/dashboard\/api\/workflow-instances\/([^/]+)\/([^/]+)\/retry$/.exec(
    url.pathname,
  );
  if (request.method === 'POST' && retryMatch) {
    auditDashboardMutation(context, request, { workflow_instance_id: retryMatch[2] });
    const outcome = await context.commands.retryWorkflowInstance(
      retryMatch[1] as WorkflowType,
      retryMatch[2],
    );
    if (outcome.accepted) notifyDashboardChanged(context);
    sendJson(response, outcome.accepted ? 202 : 409, outcome);
    return;
  }

  const retryVerificationMatch =
    /^\/dashboard\/api\/workflow-instances\/([^/]+)\/([^/]+)\/retry-verification$/.exec(
      url.pathname,
    );
  if (request.method === 'POST' && retryVerificationMatch) {
    auditDashboardMutation(context, request, { workflow_instance_id: retryVerificationMatch[2] });
    const outcome = await context.commands.retryWorkflowVerification(
      retryVerificationMatch[1] as WorkflowType,
      retryVerificationMatch[2],
    );
    if (outcome.accepted) notifyDashboardChanged(context);
    sendJson(response, outcome.accepted ? 202 : 409, outcome);
    return;
  }

  const dismissMatch = /^\/dashboard\/api\/workflow-instances\/([^/]+)\/([^/]+)\/dismiss$/.exec(
    url.pathname,
  );
  if (request.method === 'POST' && dismissMatch) {
    auditDashboardMutation(context, request, { workflow_instance_id: dismissMatch[2] });
    const outcome = await context.commands.dismissWorkflowInstance(
      dismissMatch[1] as WorkflowType,
      dismissMatch[2],
    );
    if (outcome.accepted) notifyDashboardChanged(context);
    sendJson(response, outcome.accepted ? 202 : 409, outcome);
    return;
  }

  const artifactMatch = /^\/dashboard\/api\/sandbox-runs\/([^/]+)\/artifacts\/(.+)$/.exec(
    url.pathname,
  );
  if (request.method === 'GET' && artifactMatch) {
    serveSandboxRunArtifact(context, response, artifactMatch[1], artifactMatch[2]);
    return;
  }

  const killMatch = /^\/dashboard\/api\/sandbox-runs\/([^/]+)\/kill$/.exec(url.pathname);
  if (request.method === 'POST' && killMatch) {
    auditDashboardMutation(context, request, { sandbox_run_id: killMatch[1] });
    const outcome = context.commands.killSandboxRun(killMatch[1]);
    if (outcome.accepted) notifyDashboardChanged(context);
    sendJson(response, outcome.accepted ? 202 : 409, outcome);
    return;
  }

  const runMatch = /^\/dashboard\/api\/sandbox-runs\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'GET' && runMatch) {
    const detail = dashboardSandboxRunDetail(context, runMatch[1]);
    if (!detail) {
      sendJson(response, 404, { error: 'sandbox_run_not_found' });
      return;
    }
    sendJson(response, 200, detail);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/dashboard/api/requests') {
    sendJson(response, 200, dashboardRequests(context, url.searchParams));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/dashboard/api/pull-requests') {
    sendJson(response, 200, dashboardPullRequests(context, url.searchParams));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/dashboard/api/events') {
    sendJson(response, 200, dashboardEvents(context, url.searchParams));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/dashboard/api/agents') {
    sendJson(response, 200, dashboardAgentsPayload(context));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/dashboard/api/agents/instructions') {
    await handleDashboardPromptUpsert(context, request, response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/dashboard/api/agents/instructions/delete') {
    await handleDashboardPromptDelete(context, request, response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/dashboard/api/stream') {
    await streamDashboardEvents(context, request, response);
    return;
  }

  sendJson(response, 404, { error: 'dashboard_route_not_found' });
}

const AGENT_LABELS: Record<AgentKind, string> = {
  log_reviewer: 'Log Reviewer',
  fix_implementer: 'Fix Implementer',
  pr_maintainer: 'PR Maintainer',
  linear_implementer: 'Linear Implementer',
  linear_verifier: 'Linear Verifier',
  request_router: 'Request Router',
};

function dashboardAgentsPayload(context: ApiContext): PromptsResponse {
  const stored = context.store.listPrompts();
  return {
    agents: AGENT_KINDS.map((agent) => {
      // The verifier is dispatched by the workflow of the implementer it judges, which is
      // what puts the two Linear seats under one heading in the Prompts tab.
      const workflowType: WorkflowType = agent === 'linear_verifier' ? 'linear_implementer' : agent;
      return {
        agent,
        label: AGENT_LABELS[agent],
        workflow_type: workflowType,
        workflow_label: workflowTypeLabel(workflowType),
        segments: buildAgentPromptSegments(agent),
      };
    }),
    known_repos: configuredRepositoryNames(context.config).map((repo) => repo.toLowerCase()),
    instructions: stored.map(promptWire),
    max_instructions_length: MAX_PROMPT_LENGTH,
  };
}

function promptWire(entry: {
  repo: string;
  agent: AgentKind;
  instructions: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}): PromptWire {
  return {
    repo: entry.repo,
    agent: entry.agent,
    instructions: entry.instructions,
    enabled: entry.enabled,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    revision: String(entry.updatedAt),
  };
}

function parsePromptScope(
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
  action: string,
): { repo: string; agent: AgentKind } | undefined {
  if (body.confirmed !== true) {
    sendJson(response, 400, { error: 'instructions_confirmation_required' });
    return undefined;
  }
  const agent = typeof body.agent === 'string' ? (body.agent as AgentKind) : undefined;
  if (!agent || !AGENT_KINDS.includes(agent)) {
    sendJson(response, 400, { error: 'invalid_agent', agents: [...AGENT_KINDS] });
    return undefined;
  }
  let repo: string;
  if (body.repo === PROMPT_GLOBAL_REPO) {
    repo = PROMPT_GLOBAL_REPO;
  } else {
    const parsed = dashboardRepoSlug(body.repo, { required: true });
    if (parsed.error || !parsed.value) {
      sendJson(response, 400, {
        error: 'invalid_repo',
        message: parsed.error,
        policy: 'github_owner_repo_slug',
      });
      return undefined;
    }
    repo = parsed.value.toLowerCase();
  }
  auditDashboardMutation(context, request, {
    action,
    resource: 'prompts',
    repo,
    agent,
  });
  return { repo, agent };
}

// promptRevisionConflict is the optimistic concurrency check: editing an
// existing row requires its current revision, and a mismatch means somebody saved in
// between.
function promptRevisionConflict(
  context: ApiContext,
  response: ServerResponse,
  scope: { repo: string; agent: AgentKind },
  expectedRevision: string | undefined,
): boolean {
  const existing = context.store.getPrompt(scope.repo, scope.agent);
  if (!existing) return false;
  if (expectedRevision === undefined) {
    sendJson(response, 409, {
      error: 'instructions_revision_required',
      message: 'Saving existing instructions requires their current revision.',
      revision: String(existing.updatedAt),
      updated_at: existing.updatedAt,
    });
    return true;
  }
  if (expectedRevision !== String(existing.updatedAt)) {
    sendJson(response, 409, {
      error: 'instructions_revision_conflict',
      message: 'Instructions were saved elsewhere since this revision was loaded.',
      revision: String(existing.updatedAt),
      updated_at: existing.updatedAt,
    });
    return true;
  }
  return false;
}

async function handleDashboardPromptUpsert(
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonObjectBody(request, response);
  if (!body) return;
  const scope = parsePromptScope(context, request, response, body, 'upsert_prompt');
  if (!scope) return;
  if (typeof body.instructions !== 'string' || body.instructions.trim().length === 0) {
    sendJson(response, 400, { error: 'invalid_instructions' });
    return;
  }
  if (body.instructions.length > MAX_PROMPT_LENGTH) {
    sendJson(response, 400, {
      error: 'instructions_too_long',
      max_length: MAX_PROMPT_LENGTH,
    });
    return;
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    sendJson(response, 400, { error: 'invalid_enabled' });
    return;
  }
  const expectedRevision = expectedRevisionFromRequest(request, body);
  if (promptRevisionConflict(context, response, scope, expectedRevision)) return;
  const stored = context.store.upsertPrompt({
    repo: scope.repo,
    agent: scope.agent,
    instructions: body.instructions,
    enabled: body.enabled === undefined ? true : body.enabled,
  });
  notifyDashboardChanged(context);
  sendJson(response, 200, {
    ok: true,
    instruction: promptWire(stored),
    revision: String(stored.updatedAt),
    updated_at: stored.updatedAt,
  });
}

async function handleDashboardPromptDelete(
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonObjectBody(request, response);
  if (!body) return;
  const scope = parsePromptScope(context, request, response, body, 'delete_prompt');
  if (!scope) return;
  const existing = context.store.getPrompt(scope.repo, scope.agent);
  if (!existing) {
    sendJson(response, 404, { error: 'instructions_not_found' });
    return;
  }
  const expectedRevision = expectedRevisionFromRequest(request, body);
  if (promptRevisionConflict(context, response, scope, expectedRevision)) return;
  context.store.deletePrompt(scope.repo, scope.agent);
  notifyDashboardChanged(context);
  sendJson(response, 200, { ok: true });
}

export function expectedRevisionFromRequest(
  request: IncomingMessage,
  body: Record<string, unknown>,
): string | undefined {
  if (typeof body.revision === 'string' && body.revision.trim()) return body.revision.trim();
  if (typeof body.updated_at === 'number' && Number.isFinite(body.updated_at)) {
    return String(body.updated_at);
  }
  const ifMatch = headerValue(request.headers['if-match']);
  if (!ifMatch) return undefined;
  const first = ifMatch.split(',')[0]?.trim();
  if (!first) return undefined;
  const withoutWeakPrefix = first.startsWith('W/') ? first.slice(2).trim() : first;
  if (
    withoutWeakPrefix.length >= 2 &&
    withoutWeakPrefix.startsWith('"') &&
    withoutWeakPrefix.endsWith('"')
  ) {
    return withoutWeakPrefix.slice(1, -1);
  }
  return withoutWeakPrefix;
}

export function dashboardRepoSlug(
  value: unknown,
  options: { required?: boolean } = {},
): { value: string | null; error?: string } {
  if (value === null || value === undefined || value === '') {
    return options.required
      ? { value: null, error: 'repo is required and must be a GitHub owner/repo slug' }
      : { value: null };
  }
  if (typeof value !== 'string') return { value: null, error: 'repo must be an owner/repo string' };
  const repo = value.trim();
  if (!repo) {
    return options.required
      ? { value: null, error: 'repo is required and must be a GitHub owner/repo slug' }
      : { value: null };
  }
  const parts = repo.split('/');
  if (parts.length !== 2 || !isGitHubOwnerSlug(parts[0]) || !isGitHubRepoSlug(parts[1])) {
    return { value: null, error: 'repo must be a GitHub owner/repo slug' };
  }
  return { value: repo };
}

function isGitHubOwnerSlug(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value);
}

function isGitHubRepoSlug(value: string): boolean {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) return false;
  if (value === '.' || value === '..') return false;
  if (value.toLowerCase() === '.git' || value.toLowerCase().endsWith('.git')) return false;
  return true;
}

// One page size for every list: the pages are read newest-first by an operator, and a
// smaller default only moved the cut closer without making a window mean anything.
const DASHBOARD_PAGE_LIMIT = 500;

const OVERVIEW_RECENT_LIMIT = DASHBOARD_PAGE_LIMIT;

// The Overview queues are capped well under a page: they are read at a glance, and
// what does not fit is reached from Operation.
const OVERVIEW_QUEUE_LIMIT = 100;

function dashboardLimit(value: string | null): number {
  const limit = Number(value ?? DASHBOARD_PAGE_LIMIT);
  if (!Number.isFinite(limit)) return DASHBOARD_PAGE_LIMIT;
  return Math.max(1, Math.min(DASHBOARD_PAGE_LIMIT, Math.floor(limit)));
}

function dashboardSnapshot(context: ApiContext): DashboardSnapshot {
  const counts = context.store.countWorkflowInstancesByState();
  return {
    ok: true,
    version: context.store.operatorSurfaceVersion(),
    app_version: context.appVersion ?? resolveAppVersion(context.env ?? process.env),
    updated_at: nowMs(),
    sandboxes_running: context.store.countRunningSandboxRuns(),
    sandboxes_cap: context.config.sandboxes.maxConcurrentRuns,
    open_instances: counts.reduce((total, count) => total + count.instanceCount, 0),
    requires_attention: counts
      .filter((count) => AWAITING_A_PERSON_STATES.includes(count.workflowState))
      .reduce((total, count) => total + count.instanceCount, 0),
  };
}

function dashboardOverview(context: ApiContext, params: URLSearchParams): OverviewResponse {
  const selectedWindow = overviewWindowKey(params.get('window'));
  const counts = context.store.countWorkflowInstancesByState();
  const runningByWorkflow = new Map(
    context.store
      .countSandboxRunsByWorkflowAndState()
      .filter((row) => row.runState === 'running' || row.runState === 'pending')
      .map((row) => [row.workflowType, row.count] as const),
  );
  const concurrencies = workflowConcurrencies(context.config);
  return {
    ...dashboardSnapshot(context),
    selected_window: selectedWindow,
    supported_windows: Object.keys(OVERVIEW_WINDOWS) as OverviewWindowKey[],
    machines: WORKFLOW_TYPE_ORDER.map((workflowType) => ({
      workflow_type: workflowType,
      label: workflowTypeLabel(workflowType),
      enabled: workflowTypeEnabled(context.config, workflowType),
      concurrency: concurrencies[workflowType],
      sandboxes_running: runningByWorkflow.get(workflowType) ?? 0,
      open_instances: counts
        .filter((count) => count.workflowType === workflowType)
        .reduce((total, count) => total + count.instanceCount, 0),
      states: counts
        .filter((count) => count.workflowType === workflowType)
        .map((count) => ({
          workflow_state: count.workflowState,
          state_label: stateLabel(count.workflowState),
          tone: workflowStateTone(count.workflowState),
          instance_count: count.instanceCount,
        })),
    })),
    metrics: buildOverviewMetrics(context, nowMs()),
    // No window on the queue: an instance parked a month ago still needs a person, and
    // hiding it behind the window the metrics use would lose it.
    attention: context.store
      .listWorkflowInstances(
        { workflowTypes: OPERATED_WORKFLOW_TYPES, awaitingAPerson: true },
        { limit: OVERVIEW_QUEUE_LIMIT },
      )
      .rows.map((instance) => workflowInstanceWire(context, instance)),
    // What a person owns is the queue above, so this one is the rest of what is alive:
    // the instances the machines still move on their own.
    in_progress: context.store
      .listWorkflowInstances(
        { workflowTypes: OPERATED_WORKFLOW_TYPES, open: true, awaitingAPerson: false },
        { limit: OVERVIEW_QUEUE_LIMIT },
      )
      .rows.map((instance) => workflowInstanceWire(context, instance)),
    recent_failures: context.store
      .listFailedSandboxRuns(
        OVERVIEW_RECENT_LIMIT,
        nowMs() - OVERVIEW_WINDOWS[selectedWindow].durationMs,
      )
      .map((run) => sandboxRunWire(context, run)),
    recent_pull_requests: pullRequestRows(context, OVERVIEW_WINDOWS[selectedWindow].durationMs)
      .slice(0, OVERVIEW_RECENT_LIMIT)
      .map(pullRequestWire),
  };
}

function dashboardWorkflowInstances(
  context: ApiContext,
  params: URLSearchParams,
): WorkflowInstanceListResponse {
  const limit = dashboardLimit(params.get('limit'));
  const page = context.store.listWorkflowInstances(
    {
      workflowTypes: OPERATED_WORKFLOW_TYPES,
      workflowType: workflowTypeParam(params.get('workflow_type')),
      workflowInstanceId: params.get('workflow_instance_id') ?? undefined,
      workflowState: params.get('workflow_state') ?? undefined,
      subjectSearch: params.get('subject') ?? undefined,
      awaitingAPerson: params.get('attention') === 'true' ? true : undefined,
      changedSince: windowStart(params.get('window')),
    },
    { limit, cursor: params.get('cursor') ?? undefined },
  );
  return {
    instances: page.rows.map((instance) => workflowInstanceWire(context, instance)),
    page: { limit, next_cursor: page.nextCursor },
  };
}

function dashboardWorkflowInstanceDetail(
  context: ApiContext,
  workflowType: WorkflowType,
  workflowInstanceId: string,
): WorkflowInstanceDetailResponse | undefined {
  const instance = context.store.getWorkflowInstance(workflowType, workflowInstanceId);
  if (!instance) return undefined;
  return {
    instance: workflowInstanceWire(context, instance),
    fields: instanceFields(context, workflowType, workflowInstanceId),
    sandbox_runs: context.store
      .listSandboxRunsForInstance(workflowType, workflowInstanceId)
      .map((run) => sandboxRunWire(context, run, instance.subjectLabel)),
    events: context.store.listEventsForInstance(workflowType, workflowInstanceId).map(eventWire),
    asks: context.store
      .listRequests({}, { limit: 100 })
      .rows.filter((ask) => ask.workflowInstanceId === workflowInstanceId)
      .map(requestWire),
  };
}

function dashboardSandboxRunDetail(
  context: ApiContext,
  sandboxRunId: string,
): SandboxRunDetailResponse | undefined {
  const run = context.store.getSandboxRun(sandboxRunId);
  if (!run) return undefined;
  const events = context.store.listEventsForSandboxRun(sandboxRunId).map(eventWire);
  return {
    run: sandboxRunWire(context, run),
    summary: summaryOf(events),
    events,
    artifacts: context.store.listSandboxRunArtifacts(sandboxRunId).map((artifact) => ({
      name: artifact.name,
      url: artifact.url,
      size_bytes: artifact.size_bytes,
    })),
  };
}

function dashboardRequests(context: ApiContext, params: URLSearchParams): RequestListResponse {
  const limit = dashboardLimit(params.get('limit'));
  const page = context.store.listRequests(
    {
      requestSource: requestSourceParam(params.get('source')),
      since: windowStart(params.get('window')) ?? windowStart('24h'),
    },
    { limit, cursor: params.get('cursor') ?? undefined },
  );
  return {
    requests: page.rows.map(requestWire),
    page: { limit, next_cursor: page.nextCursor },
  };
}

function dashboardPullRequests(
  context: ApiContext,
  params: URLSearchParams,
): PullRequestListResponse {
  const selectedWindow = overviewWindowKey(params.get('window'));
  const rows = pullRequestRows(context, OVERVIEW_WINDOWS[selectedWindow].durationMs);
  return {
    pull_requests: rows.map(pullRequestWire),
    kpis: pullRequestKpis(selectedWindow, rows),
    repositories: [...new Set(rows.map((row) => row.repositoryFullName))].sort(),
  };
}

function dashboardEvents(context: ApiContext, params: URLSearchParams): EventListResponse {
  const limit = dashboardLimit(params.get('limit'));
  const page = context.store.listEvents(
    {
      workflowType: workflowTypeParam(params.get('workflow_type')),
      workflowInstanceId: params.get('workflow_instance_id') ?? undefined,
      sandboxRunId: params.get('sandbox_run_id') ?? undefined,
      eventTypePrefixes: eventFamilyPrefixes(params.getAll('family')),
      since: windowStart(params.get('window')) ?? windowStart('24h'),
    },
    { limit, cursor: params.get('cursor') ?? undefined },
  );
  return {
    events: page.rows.map(eventWire),
    page: { limit, next_cursor: page.nextCursor },
  };
}

function serveSandboxRunArtifact(
  context: ApiContext,
  response: ServerResponse,
  sandboxRunId: string,
  name: string,
): void {
  const artifact = context.store.readSandboxRunArtifact(sandboxRunId, decodeURIComponent(name));
  if (!artifact) {
    sendJson(response, 404, { error: 'artifact_not_found' });
    return;
  }
  response.writeHead(200, {
    'content-type':
      DASHBOARD_ASSET_CONTENT_TYPES[extname(artifact.name)] ?? 'text/plain; charset=utf-8',
    'content-length': String(artifact.content.byteLength),
    'cache-control': 'no-store',
  });
  response.end(artifact.content);
}

// --------------------------------------------------------------- wire mapping

function workflowInstanceWire(
  context: ApiContext,
  instance: WorkflowInstanceSummary,
): WorkflowInstanceRow {
  return {
    workflow_type: instance.workflowType,
    workflow_instance_id: instance.workflowInstanceId,
    workflow_state: instance.workflowState,
    state_label: stateLabel(instance.workflowState),
    tone: workflowStateTone(instance.workflowState),
    workflow_label: workflowTypeLabel(instance.workflowType),
    subject: {
      kind: instance.subjectKind,
      label: instance.subjectLabel,
      url: subjectUrl(instance),
    },
    repository_full_name: instance.repositoryFullName,
    attempts: attemptsOf(context, instance),
    needs_human_reason: instance.needsHumanReason,
    requires_attention: ATTENTION_STATES.includes(instance.workflowState),
    sandbox_run_id: instance.sandboxRunId,
    sandbox_run_count: instance.sandboxRunCount,
    last_run_state: instance.lastRunState,
    last_run_ended_at: instance.lastRunEndedAt,
    state_changed_at: instance.stateChangedAt,
    created_at: instance.createdAt,
  };
}

function sandboxRunWire(
  context: ApiContext,
  run: SandboxRun,
  subjectLabel?: string,
): SandboxRunRow {
  const subject =
    subjectLabel ??
    context.store.getWorkflowInstance(run.workflowType, run.workflowInstanceId)?.subjectLabel;
  return {
    sandbox_run_id: run.id,
    agent_name: run.agentName,
    run_state: run.runState,
    workflow_type: run.workflowType,
    workflow_instance_id: run.workflowInstanceId,
    subject_label: subject ?? null,
    sandbox_session_id: run.sandboxSessionId,
    cost_usd: run.costUsd,
    error: run.errorMessage,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    duration_ms: run.endedAt === null ? null : run.endedAt - run.startedAt,
  };
}

function eventWire(event: EventLogEntry): EventRow {
  return {
    id: event.id,
    event_type: event.eventType,
    family: eventFamily(event.eventType),
    workflow_type: event.workflowType,
    workflow_instance_id: event.workflowInstanceId,
    sandbox_run_id: event.sandboxRunId,
    subject_label: null,
    from_state: event.fromState,
    to_state: event.toState,
    metadata: eventMetadataObject(event.metadata),
    created_at: event.createdAt,
  };
}

function requestWire(request: RequestSummary): RequestRow {
  const outcome = requestOutcome(request);
  return {
    id: request.id,
    request_source: request.requestSource,
    requester: request.requesterExternalId,
    request_text: request.requestText,
    repository_full_name: request.repositoryFullName,
    subject_type: request.subjectType,
    subject_external_id: request.subjectExternalId,
    outcome,
    outcome_label: requestOutcomeLabel(request, outcome),
    workflow_type: request.workflowType,
    workflow_instance_id: request.workflowInstanceId,
    workflow_state: null,
    created_at: request.createdAt,
    consumed_at: request.consumedAt,
  };
}

function pullRequestWire(pullRequest: OurPullRequest): PullRequestRow {
  return {
    repository_full_name: pullRequest.repositoryFullName,
    pull_request_number: pullRequest.pullRequestNumber,
    url: `https://github.com/${pullRequest.repositoryFullName}/pull/${pullRequest.pullRequestNumber}`,
    workflow_type: pullRequest.workflowType,
    workflow_instance_id: pullRequest.workflowInstanceId,
    workflow_state: pullRequest.workflowState,
    state_label: stateLabel(pullRequest.workflowState),
    tone: workflowStateTone(pullRequest.workflowState),
    opened_by_workflow_type: pullRequest.openedByWorkflowType,
    opened_by_workflow_label:
      pullRequest.openedByWorkflowType === null
        ? null
        : workflowTypeLabel(pullRequest.openedByWorkflowType),
    created_at: pullRequest.createdAt,
    finished_at: PULL_REQUEST_FINISHED_STATES.includes(pullRequest.workflowState)
      ? pullRequest.finishedAt
      : null,
  };
}

// summaryOf reads what the agent reported when its run ended, which the pool records
// on the closing event and nothing else keeps.
function summaryOf(events: EventRow[]): string | null {
  const finished = events.find((event) => event.event_type === 'sandbox.finished');
  const summary = finished?.metadata?.summary;
  return typeof summary === 'string' && summary.length > 0 ? summary : null;
}

// attemptsOf reads as what the machine counts: pull request passes against the cap it
// was given, or the corrective iteration a ticket is on.
function attemptsOf(context: ApiContext, instance: WorkflowInstanceSummary): string | null {
  if (instance.attemptCount !== null) {
    return `${instance.attemptCount} / ${context.config.workflows.prMaintainer.maxPushAttempts}`;
  }
  if (instance.iterationNumber !== null) {
    return `iteration ${instance.iterationNumber} / ${context.config.workflows.linearImplementer.maxIterations}`;
  }
  return null;
}

// instanceFields drops the columns every machine has, so what is left is what this one
// keeps and nothing the row above already shows.
function instanceFields(
  context: ApiContext,
  workflowType: WorkflowType,
  workflowInstanceId: string,
): Record<string, string | number | null> {
  const row = context.store.getWorkflowInstanceFields(workflowType, workflowInstanceId) ?? {};
  const fields: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (SHARED_INSTANCE_COLUMNS.includes(key)) continue;
    if (value === null || value === '') continue;
    fields[key] = typeof value === 'number' ? value : String(value);
  }
  return fields;
}

// ------------------------------------------------------------------ reasoning

function requestOutcome(request: RequestSummary): RequestOutcome {
  if (request.consumedAt !== null) return 'taken';
  if (request.workflowState === 'rr_unresolvable') return 'unresolvable';
  if (request.resolutionNote === REPLY_CAP_REACHED_NOTE) return 'not_answered';
  if (request.workflowState === 'rr_pending' || request.workflowState === 'rr_routing') {
    return 'routing';
  }
  return 'waiting';
}

// requestOutcomeLabel says what became of an ask in the words an operator needs: which
// machine holds it, or why nobody will answer.
function requestOutcomeLabel(request: RequestSummary, outcome: RequestOutcome): string {
  switch (outcome) {
    case 'taken':
      // The column is nullable, though the write that consumes an ask always names the
      // workflow that took it.
      return request.workflowType === null
        ? 'Delivered to a workflow'
        : `Delivered to ${workflowTypeLabel(request.workflowType)}`;
    case 'routing':
      return 'Delivered to RequestRouter';
    case 'unresolvable':
      return request.resolutionNote === null
        ? 'Impossible to route; needs a person'
        : `Impossible to route; needs a person: ${request.resolutionNote}`;
    case 'not_answered':
      return 'Not answered; the reply cap for that thread was reached';
    case 'waiting':
      return 'Routed; no workflow has taken it yet';
  }
}

function pullRequestRows(context: ApiContext, durationMs: number): OurPullRequest[] {
  return context.store.listOurPullRequests(nowMs() - durationMs);
}

function pullRequestKpis(
  window: OverviewWindowKey,
  rows: OurPullRequest[],
): PullRequestListResponse['kpis'] {
  const created = rows.filter((row) => row.openedByWorkflowType !== null).length;
  const merged = rows.filter((row) => row.workflowState === 'prm_merged');
  const closedUnmerged = rows.filter((row) => row.workflowState === 'prm_closed');
  const finished = merged.length + closedUnmerged.length;
  const openMs = [...merged, ...closedUnmerged]
    .map((row) => (row.finishedAt === null ? null : row.finishedAt - row.createdAt))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  return {
    window,
    created,
    merged: merged.length,
    closed_unmerged: closedUnmerged.length,
    still_open: rows.length - finished,
    accepted_rate: finished === 0 ? null : merged.length / finished,
    median_time_open_ms: openMs.length === 0 ? null : openMs[Math.floor(openMs.length / 2)],
  };
}

function buildOverviewMetrics(
  context: ApiContext,
  now: number,
): Record<OverviewWindowKey, OverviewMetricsWindow> {
  const metrics = {} as Record<OverviewWindowKey, OverviewMetricsWindow>;
  for (const [key, window] of Object.entries(OVERVIEW_WINDOWS) as Array<
    [OverviewWindowKey, (typeof OVERVIEW_WINDOWS)[OverviewWindowKey]]
  >) {
    const arrivals = context.store.countStateArrivals(
      METRIC_STATES,
      now - window.durationMs,
      window.bucketMs,
    );
    const pullRequests = pullRequestRows(context, window.durationMs);
    const points: Record<OverviewMetricKey, Array<{ timestamp: number; count: number }>> = {
      items_triaged: metricPoints(arrivals, METRIC_ARRIVAL_STATES.items_triaged),
      incidents_handled: metricPoints(arrivals, METRIC_ARRIVAL_STATES.incidents_handled),
      prs_opened: pullRequests
        .filter((pullRequest) => pullRequest.openedByWorkflowType !== null)
        .map((pullRequest) => ({ timestamp: pullRequest.createdAt, count: 1 })),
      prs_merged: pullRequests
        .filter(
          (pullRequest) =>
            pullRequest.workflowState === 'prm_merged' && pullRequest.finishedAt !== null,
        )
        .map((pullRequest) => ({ timestamp: pullRequest.finishedAt ?? 0, count: 1 })),
    };
    const series = {} as Record<OverviewMetricKey, MetricSeriesPoint[]>;
    const totals = {} as Record<OverviewMetricKey, number>;
    for (const metric of OVERVIEW_METRICS) {
      series[metric] = bucketMetricSeries(now, window, points[metric]);
      totals[metric] = points[metric].reduce((total, point) => total + point.count, 0);
    }
    metrics[key] = { window: key, bucket_ms: window.bucketMs, series, totals };
  }
  return metrics;
}

function metricPoints(
  arrivals: StateArrivalBucket[],
  toStates: readonly string[],
): Array<{ timestamp: number; count: number }> {
  return arrivals
    .filter((arrival) => toStates.includes(arrival.toState))
    .map((arrival) => ({ timestamp: arrival.bucketStart, count: arrival.arrivalCount }));
}

function bucketMetricSeries(
  now: number,
  window: (typeof OVERVIEW_WINDOWS)[OverviewWindowKey],
  points: Array<{ timestamp: number; count: number }>,
): MetricSeriesPoint[] {
  const start = alignBucketStart(now, window.bucketMs) - (window.buckets - 1) * window.bucketMs;
  const buckets = Array.from({ length: window.buckets }, (_, index) => ({
    timestamp: start + index * window.bucketMs,
    value: 0,
  }));
  for (const point of points) {
    if (!Number.isFinite(point.timestamp) || point.timestamp < start) continue;
    const bucketIndex = Math.floor((point.timestamp - start) / window.bucketMs);
    if (bucketIndex < 0 || bucketIndex >= buckets.length) continue;
    buckets[bucketIndex].value += point.count;
  }
  return buckets;
}

function alignBucketStart(timestamp: number, bucketMs: number): number {
  return Math.floor(timestamp / bucketMs) * bucketMs;
}

function overviewWindowKey(value: string | null): OverviewWindowKey {
  return value === '7d' || value === '30d' ? value : '24h';
}

// The label is the name the engine dispatches that machine's agent by, so a run card and
// the workflow it belongs to read the same.
function workflowTypeLabel(workflowType: WorkflowType): string {
  switch (workflowType) {
    case 'request_router':
      return 'RequestRouter';
    case 'linear_implementer':
      return 'LinearImplementer';
    case 'fix_implementer':
      return 'FixImplementer';
    case 'log_reviewer':
      return 'LogReviewer';
    case 'pr_maintainer':
      return 'PrMaintainer';
  }
}

function workflowTypeEnabled(config: AppConfig, workflowType: WorkflowType): boolean {
  switch (workflowType) {
    case 'request_router':
      return config.workflows.requestRouter.enabled;
    case 'linear_implementer':
      return config.workflows.linearImplementer.enabled;
    case 'fix_implementer':
      return config.workflows.fixImplementer.enabled;
    case 'log_reviewer':
      return config.workflows.logReviewer.enabled;
    case 'pr_maintainer':
      return config.workflows.prMaintainer.enabled;
  }
}

// ------------------------------------------------------------------- wording

// stateLabel says what a state means in a few words. A state with no entry reads as its
// own name without the machine prefix, so adding one to a machine never breaks a surface.
function stateLabel(workflowState: string): string {
  return (
    WORKFLOW_STATE_LABELS[workflowState] ??
    workflowState.replace(/^[a-z]+_/, '').replaceAll('_', ' ')
  );
}

function eventFamily(eventType: string): EventRow['family'] {
  const prefix = eventType.split('.')[0];
  switch (prefix) {
    case 'workflow':
    case 'sandbox':
    case 'agent':
    case 'operator':
      return prefix;
    default:
      return 'orchestrator';
  }
}

function eventFamilyPrefixes(families: string[]): string[] | undefined {
  const prefixes = families.filter((family) => EVENT_FAMILIES.includes(family));
  return prefixes.length === 0 ? undefined : prefixes.map((family) => `${family}.`);
}

function eventMetadataObject(metadata: string | null): Record<string, unknown> | null {
  if (metadata === null) return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    return objectPayload(parsed);
  } catch {
    return null;
  }
}

function subjectUrl(instance: WorkflowInstanceSummary): string | null {
  if (instance.repositoryFullName === null || instance.pullRequestNumber === null) return null;
  return `https://github.com/${instance.repositoryFullName}/pull/${instance.pullRequestNumber}`;
}

// -------------------------------------------------------------------- params

function workflowTypeParam(value: string | null): WorkflowType | undefined {
  return WORKFLOW_TYPE_ORDER.find((workflowType) => workflowType === value);
}

function requestSourceParam(value: string | null): RequestSource | undefined {
  return REQUEST_SOURCES.find((source) => source === value);
}

function windowStart(value: string | null): number | undefined {
  if (value === null) return undefined;
  const window = OVERVIEW_WINDOWS[overviewWindowKey(value)];
  return nowMs() - window.durationMs;
}

function objectPayload(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function dashboardSafeError(error: unknown, fallback = 'dashboard_request_failed'): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const sanitized = sanitizeDashboardText(message).trim();
  return sanitized || fallback;
}

function shouldRedactDashboardKey(key: string): boolean {
  return /(authorization|password|passwd|token|secret|credential|api[_-]?key|private[_-]?key)/i.test(
    key,
  );
}

function sanitizeDashboardText(value: string): string {
  let sanitized = value;
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
  sanitized = sanitized.replace(
    /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)[A-Z0-9_]*=)([^\s]+)/gi,
    '$1[redacted]',
  );
  sanitized = sanitized.replace(
    /(authorization\s*[:=]\s*)(basic|bearer)?\s*[^\s,;]+/gi,
    '$1[redacted]',
  );
  sanitized = sanitized.replace(
    /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@\s]+)@([^\s/?#]+)([^\s]*)/g,
    (_match, scheme: string, _credentials: string, host: string, rest: string) =>
      `${scheme}[redacted]@${host}${sanitizeUrlRest(rest)}`,
  );
  sanitized = sanitized.replace(
    /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s?#]+)(\?[^ \n\r\t]*)/g,
    (_match, base, query) => {
      const params = new URLSearchParams(String(query).slice(1));
      let changed = false;
      for (const key of [...params.keys()]) {
        if (shouldRedactDashboardKey(key)) {
          params.set(key, '[redacted]');
          changed = true;
        }
      }
      return changed ? `${base}?${params.toString()}` : `${base}${query}`;
    },
  );
  for (const secret of dashboardSensitiveEnvValues()) {
    sanitized = sanitized.split(secret).join('[redacted]');
  }
  return sanitized;
}

function dashboardSensitiveEnvValues(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => value && value.length >= 8 && shouldRedactDashboardKey(key))
    .map((entry) => entry[1] as string);
}

function sanitizeUrlRest(rest: string): string {
  if (!rest.startsWith('?') && !rest.includes('?')) return rest;
  const [pathPart, queryPart] = rest.split('?', 2);
  if (!queryPart) return rest;
  const params = new URLSearchParams(queryPart);
  for (const key of [...params.keys()]) {
    if (shouldRedactDashboardKey(key)) params.set(key, '[redacted]');
  }
  return `${pathPart}?${params.toString()}`;
}

async function streamDashboardEvents(
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let lastVersion = '';
  const send = (event: string, payload: unknown): void => {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const publishIfChanged = (): void => {
    const snapshot = dashboardSnapshot(context);
    const version = String(snapshot.version);
    if (version === lastVersion) return;
    lastVersion = version;
    send('dashboard.snapshot', snapshot);
  };
  send('dashboard.connected', { retry_ms: DASHBOARD_EVENT_RETRY_MS });
  publishIfChanged();
  const unsubscribe = subscribeDashboardEvents(context, publishIfChanged);
  const timer = setInterval(publishIfChanged, DASHBOARD_EVENT_POLL_MS);
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
  await new Promise<void>((resolve) => {
    request.on('close', resolve);
    response.on('close', resolve);
  }).finally(() => {
    unsubscribe();
    clearInterval(timer);
    clearInterval(heartbeat);
  });
}

const DASHBOARD_EVENT_POLL_MS = 2_000;
const DASHBOARD_EVENT_RETRY_MS = 3_000;
const dashboardEventListeners = new WeakMap<ApiContext, Set<() => void>>();

export function subscribeDashboardEvents(context: ApiContext, listener: () => void): () => void {
  let listeners = dashboardEventListeners.get(context);
  if (!listeners) {
    listeners = new Set();
    dashboardEventListeners.set(context, listeners);
  }
  listeners.add(listener);
  return () => listeners?.delete(listener);
}

export function notifyDashboardChanged(context: ApiContext): void {
  const listeners = dashboardEventListeners.get(context);
  if (!listeners) return;
  for (const listener of listeners) {
    listener();
  }
}

function auditDashboardMutation(
  context: ApiContext,
  request: IncomingMessage,
  payload: Record<string, unknown>,
): void {
  context.store.appendEvent({
    eventType: 'operator.dashboard_write_requested',
    metadata: {
      ...payload,
      method: request.method ?? 'GET',
      path: (request.url ?? '/').split('?')[0],
      session: dashboardAuditSessionContext(request),
      request: dashboardAuditRequestContext(request),
    },
  });
}

// Jardinero has no login: whoever proxies it authenticates the browser and says who it
// was on the request. Each proxy spells that differently, so this reads the ones we know
// and records which answered. Only headers a proxy owns and overwrites belong here;
// conventional ones like `x-forwarded-email` are left out on purpose, because any client
// can send those and forge the audit trail.
const IDENTITY_HEADERS: Array<{ provider: string; email: string[]; subject: string[] }> = [
  {
    provider: 'pomerium',
    email: ['x-pomerium-claim-email', 'x-pomerium-authenticated-user-email'],
    subject: ['x-pomerium-claim-sub', 'x-pomerium-jwt-assertion-sub'],
  },
  {
    provider: 'oauth2-proxy',
    email: ['x-auth-request-email'],
    subject: ['x-auth-request-user'],
  },
];

function dashboardAuditSessionContext(request: IncomingMessage): Record<string, unknown> | null {
  for (const candidate of IDENTITY_HEADERS) {
    const email = firstHeader(request, candidate.email);
    const subject = firstHeader(request, candidate.subject);
    if (!email && !subject) continue;
    return {
      provider: candidate.provider,
      email: email ?? null,
      subject: subject ? createHash('sha256').update(subject).digest('hex').slice(0, 16) : null,
    };
  }
  return null;
}

function firstHeader(request: IncomingMessage, names: string[]): string | undefined {
  for (const name of names) {
    const value = headerValue(request.headers[name]);
    if (value) return value;
  }
  return undefined;
}

function dashboardAuditRequestContext(request: IncomingMessage): Record<string, unknown> {
  return {
    request_id:
      headerValue(request.headers['x-request-id']) ??
      headerValue(request.headers['x-correlation-id']) ??
      null,
    user_agent: headerValue(request.headers['user-agent']) ?? null,
    remote_address: request.socket.remoteAddress ?? null,
  };
}

type DashboardTab = 'overview' | 'operation' | 'requests' | 'prs' | 'events' | 'prompts';

function dashboardTabFromPath(pathname: string): DashboardTab | undefined {
  if (
    pathname === '/dashboard' ||
    pathname === '/dashboard/' ||
    pathname === '/dashboard/overview'
  ) {
    return 'overview';
  }
  if (pathname === '/dashboard/operation') return 'operation';
  if (pathname === '/dashboard/requests') return 'requests';
  if (pathname === '/dashboard/prs') return 'prs';
  if (pathname === '/dashboard/events') return 'events';
  if (pathname === '/dashboard/prompts') return 'prompts';
  return undefined;
}

// The dashboard SPA (web/) is built by Vite into dist/public and served from
// here. renderSpaShell emits the bootstrap document; the hashed JS/CSS bundles
// are served by serveDashboardAsset. When no build is present (e.g. the test
// run, which only compiles the server), the shell still renders valid HTML with
// the root mount point so page routes stay 200.

let dashboardPublicDir: string | null | undefined;
let dashboardManifest: { entry: string; css: string[] } | null | undefined;

const DASHBOARD_THEME_BOOTSTRAP = `  <script>
    (() => {
      try {
        const theme = window.localStorage.getItem('jardinero-dashboard-theme') === 'dark' ? 'dark' : 'light';
        document.documentElement.dataset.theme = theme;
      } catch {
        document.documentElement.dataset.theme = 'light';
      }
    })();
  </script>`;

// The SPA lives under /dashboard/, so these icon URLs carry that prefix, unlike the
// ones in the package's root manifest.
const DASHBOARD_FAVICON_LINKS = `  <link rel="icon" href="/dashboard/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" href="/dashboard/favicon-32x32.png" sizes="32x32">
  <link rel="icon" type="image/png" href="/dashboard/favicon-16x16.png" sizes="16x16">
  <link rel="apple-touch-icon" href="/dashboard/apple-touch-icon.png">
  <link rel="manifest" href="/dashboard/site.webmanifest">
  <meta name="theme-color" content="#16351f">`;

function resolveDashboardPublicDir(): string | null {
  if (dashboardPublicDir !== undefined) return dashboardPublicDir;
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled (dist/src/transport/dashboard) → dist/public; tsx dev
  // (src/transport/dashboard) → dist/public.
  for (const candidate of [
    resolve(here, '../../../public'),
    resolve(here, '../../../dist/public'),
  ]) {
    if (existsSync(candidate)) {
      dashboardPublicDir = candidate;
      return candidate;
    }
  }
  dashboardPublicDir = null;
  return null;
}

function loadDashboardManifest(): { entry: string; css: string[] } | null {
  if (dashboardManifest !== undefined) return dashboardManifest;
  const dir = resolveDashboardPublicDir();
  if (!dir) {
    dashboardManifest = null;
    return null;
  }
  try {
    const raw = readFileSync(join(dir, '.vite', 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw) as Record<string, { file: string; css?: string[] }>;
    const entry = manifest['index.html'];
    dashboardManifest = entry ? { entry: entry.file, css: entry.css ?? [] } : null;
  } catch {
    dashboardManifest = null;
  }
  return dashboardManifest;
}

function renderSpaShell(activeTab: DashboardTab): string {
  const assets = loadDashboardManifest();
  const cssLinks = assets
    ? assets.css
        .map((href) => `  <link rel="stylesheet" href="/dashboard/${escapeHtml(href)}">`)
        .join('\n')
    : '';
  const script = assets
    ? `  <script type="module" src="/dashboard/${escapeHtml(assets.entry)}"></script>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Jardinero Operator Dashboard</title>
${DASHBOARD_FAVICON_LINKS}
${DASHBOARD_THEME_BOOTSTRAP}
${cssLinks}
</head>
<body>
  <div id="root" data-tab="${activeTab}"></div>
${script}
</body>
</html>`;
}

const DASHBOARD_ASSET_CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveDashboardAsset(response: ServerResponse, pathname: string): void {
  const dir = resolveDashboardPublicDir();
  if (!dir) {
    sendJson(response, 404, { error: 'asset_not_found' });
    return;
  }
  const relative = decodeURIComponent(pathname.slice('/dashboard/'.length));
  const assetsRoot = join(dir, 'assets');
  const filePath = normalize(join(dir, relative));
  // Confine reads to dist/public/assets; reject any traversal.
  if (filePath !== assetsRoot && !filePath.startsWith(assetsRoot + sep)) {
    sendJson(response, 404, { error: 'asset_not_found' });
    return;
  }
  let content: Buffer;
  try {
    content = readFileSync(filePath);
  } catch {
    sendJson(response, 404, { error: 'asset_not_found' });
    return;
  }
  response.writeHead(200, {
    'content-type': DASHBOARD_ASSET_CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
    'cache-control': 'public, max-age=31536000, immutable',
  });
  response.end(content);
}

// Favicon and manifest files copied verbatim from web/public into dist/public. Their
// names are stable, unlike the hashed bundles, so they are served without immutable
// caching.
const DASHBOARD_PUBLIC_FILES = new Set([
  'favicon.ico',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'favicon-48x48.png',
  'apple-touch-icon.png',
  'android-chrome-192x192.png',
  'android-chrome-512x512.png',
  'site.webmanifest',
]);

function dashboardPublicFileName(pathname: string): string {
  return pathname.slice('/dashboard/'.length);
}

function serveDashboardPublicFile(response: ServerResponse, pathname: string): void {
  const dir = resolveDashboardPublicDir();
  const name = dashboardPublicFileName(pathname);
  if (!dir || !DASHBOARD_PUBLIC_FILES.has(name)) {
    sendJson(response, 404, { error: 'asset_not_found' });
    return;
  }
  let content: Buffer;
  try {
    content = readFileSync(join(dir, name));
  } catch {
    sendJson(response, 404, { error: 'asset_not_found' });
    return;
  }
  response.writeHead(200, {
    'content-type': DASHBOARD_ASSET_CONTENT_TYPES[extname(name)] ?? 'application/octet-stream',
    'cache-control': 'public, max-age=86400',
  });
  response.end(content);
}

function renderDashboardNotFound(): string {
  return renderHtml(
    'Dashboard Route Not Found',
    `<main class="signin"><section class="panel"><h1>Dashboard route not found</h1><a href="/dashboard">Return to dashboard</a></section></main>`,
  );
}

function renderHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
${DASHBOARD_FAVICON_LINKS}
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #17202a; }
    a { color: #2457a6; text-decoration: none; }
    h1, h2, h3, p { margin: 0; }
    button, input, select, textarea { font: inherit; }
    button { border: 0; background: #17202a; color: white; padding: 10px 14px; border-radius: 6px; cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: 0.62; }
    label { display: grid; gap: 8px; font-weight: 650; }
    input { border: 1px solid #b9c0c9; border-radius: 6px; padding: 10px 12px; min-width: 280px; background: white; color: #17202a; font-weight: 400; }
    [aria-invalid="true"] { border-color: #d92d20; box-shadow: 0 0 0 3px rgb(217 45 32 / 12%); }
    .signin { min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
    .panel { display: grid; gap: 18px; background: white; border: 1px solid #d8dde5; border-radius: 8px; padding: 28px; box-shadow: 0 16px 36px rgb(23 32 42 / 8%); }
    .eyebrow { color: #596677; font-size: 12px; font-weight: 800; letter-spacing: 0; text-transform: uppercase; }
    .error { color: #b42318; background: #fff1f0; border: 1px solid #ffcbc5; border-radius: 6px; padding: 10px 12px; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
