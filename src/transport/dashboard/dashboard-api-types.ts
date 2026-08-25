// Shared wire types for the operator dashboard API (`/dashboard/api/*`).
//
// This is the single source of truth for the JSON the server emits from
// dashboard.ts (snake_case on the wire) and the React frontend in `web/` consumes.
// The domain shapes below mirror the backend types in `../../store/types.ts`; they
// are duplicated here (rather than imported) so the module is self-contained and
// compiles cleanly under both the Node backend (NodeNext) and the browser bundle
// (Vite/bundler resolution) without dragging Node globals into the web build. Keep
// them in lockstep with the backend.

// --- Enums mirrored from the backend domain model ---

export type WorkflowType =
  | 'request_router'
  | 'linear_implementer'
  | 'fix_implementer'
  | 'log_reviewer'
  | 'pr_maintainer';

export type SandboxRunState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'aborted'
  | 'orphaned'
  | 'skipped';

export type RequestSource = 'discord' | 'github' | 'linear' | 'cron' | 'operator';

export type WorkflowSubjectKind =
  | 'request'
  | 'linear_issue'
  | 'finding'
  | 'log_target'
  | 'pull_request';

// --- Dashboard wire types ---

/** Connection-health states surfaced by the live indicator. */
export type LiveState = 'live' | 'degraded';

export type OverviewWindowKey = '24h' | '7d' | '30d';

export type OverviewMetricKey = 'items_triaged' | 'prs_opened' | 'prs_merged' | 'incidents_handled';

/** GET `/dashboard/api/session` and the SSE `dashboard.snapshot` payload. */
export interface DashboardSnapshot {
  ok: true;
  version: string;
  app_version: string;
  updated_at: number;
  sandboxes_running: number;
  sandboxes_cap: number;
  open_instances: number;
  requires_attention: number;
}

export type WorkflowStateTone = 'working' | 'waiting' | 'attention' | 'closed' | 'done';

export interface WorkflowStateCount {
  workflow_state: string;
  state_label: string;
  tone: WorkflowStateTone;
  instance_count: number;
}

export interface WorkflowMachineRow {
  workflow_type: WorkflowType;
  label: string;
  enabled: boolean;
  concurrency: number;
  sandboxes_running: number;
  open_instances: number;
  states: WorkflowStateCount[];
}

export interface MetricSeriesPoint {
  timestamp: number;
  value: number;
}

export interface OverviewMetricsWindow {
  window: OverviewWindowKey;
  bucket_ms: number;
  series: Record<OverviewMetricKey, MetricSeriesPoint[]>;
  totals: Record<OverviewMetricKey, number>;
}

/** GET `/dashboard/api/overview`. */
export interface OverviewResponse extends DashboardSnapshot {
  selected_window: OverviewWindowKey;
  supported_windows: OverviewWindowKey[];
  machines: WorkflowMachineRow[];
  metrics: Record<OverviewWindowKey, OverviewMetricsWindow>;
  attention: WorkflowInstanceRow[];
  in_progress: WorkflowInstanceRow[];
  recent_failures: SandboxRunRow[];
  recent_pull_requests: PullRequestRow[];
}

export interface WorkflowSubject {
  kind: WorkflowSubjectKind;
  label: string;
  url: string | null;
}

/** A row in GET `/dashboard/api/workflow-instances`. */
export interface WorkflowInstanceRow {
  workflow_type: WorkflowType;
  workflow_instance_id: string;
  workflow_state: string;
  state_label: string;
  tone: WorkflowStateTone;
  workflow_label: string;
  subject: WorkflowSubject;
  repository_full_name: string | null;
  attempts: string | null;
  needs_human_reason: string | null;
  requires_attention: boolean;
  sandbox_run_id: string | null;
  sandbox_run_count: number;
  last_run_state: SandboxRunState | null;
  last_run_ended_at: number | null;
  state_changed_at: number;
  created_at: number;
}

export interface PageWire {
  limit: number;
  next_cursor: string | null;
}

/** GET `/dashboard/api/workflow-instances`. */
export interface WorkflowInstanceListResponse {
  instances: WorkflowInstanceRow[];
  page: PageWire;
}

export interface SandboxRunRow {
  sandbox_run_id: string;
  agent_name: string;
  run_state: SandboxRunState;
  workflow_type: WorkflowType;
  workflow_instance_id: string;
  subject_label: string | null;
  sandbox_session_id: string | null;
  cost_usd: number | null;
  error: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
}

/** GET `/dashboard/api/workflow-instances/{workflowType}/{id}`. */
export interface WorkflowInstanceDetailResponse {
  instance: WorkflowInstanceRow;
  // The instance row by its own column names, so the frontend needs to know none of
  // the five tables.
  fields: Record<string, string | number | null>;
  sandbox_runs: SandboxRunRow[];
  events: EventRow[];
  asks: RequestRow[];
}

export interface EventRow {
  id: string;
  event_type: string;
  family: 'workflow' | 'sandbox' | 'agent' | 'orchestrator' | 'operator';
  workflow_type: WorkflowType | null;
  workflow_instance_id: string | null;
  sandbox_run_id: string | null;
  subject_label: string | null;
  from_state: string | null;
  to_state: string | null;
  metadata: Record<string, unknown> | null;
  created_at: number;
}

export interface ArtifactLink {
  name: string;
  url: string;
  size_bytes: number;
}

/** GET `/dashboard/api/sandbox-runs/{id}`. */
export interface SandboxRunDetailResponse {
  run: SandboxRunRow;
  summary: string | null;
  events: EventRow[];
  artifacts: ArtifactLink[];
}

/** GET `/dashboard/api/events`. */
export interface EventListResponse {
  events: EventRow[];
  page: PageWire;
}

export type RequestOutcome = 'routing' | 'unresolvable' | 'taken' | 'not_answered' | 'waiting';

/** A row in GET `/dashboard/api/requests`. */
export interface RequestRow {
  id: string;
  request_source: RequestSource;
  requester: string | null;
  request_text: string | null;
  repository_full_name: string | null;
  subject_type: string | null;
  subject_external_id: string | null;
  outcome: RequestOutcome;
  outcome_label: string;
  workflow_type: WorkflowType | null;
  workflow_instance_id: string | null;
  workflow_state: string | null;
  created_at: number;
  consumed_at: number | null;
}

/** GET `/dashboard/api/requests`. */
export interface RequestListResponse {
  requests: RequestRow[];
  page: PageWire;
}

/** A row in GET `/dashboard/api/pull-requests`. */
export interface PullRequestRow {
  repository_full_name: string;
  pull_request_number: number;
  url: string;
  workflow_type: WorkflowType;
  workflow_instance_id: string;
  workflow_state: string;
  state_label: string;
  tone: WorkflowStateTone;
  opened_by_workflow_type: WorkflowType | null;
  opened_by_workflow_label: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface PullRequestKpis {
  window: OverviewWindowKey;
  created: number;
  merged: number;
  closed_unmerged: number;
  still_open: number;
  accepted_rate: number | null;
  median_time_open_ms: number | null;
}

/** GET `/dashboard/api/pull-requests`. */
export interface PullRequestListResponse {
  pull_requests: PullRequestRow[];
  kpis: PullRequestKpis;
  repositories: string[];
}

/** POST `/dashboard/api/sandbox-runs/{id}/kill` and `.../{id}/retry`. */
export interface OperatorCommandResponse {
  accepted: boolean;
  reason?: string;
}

// --- Operator prompts (dashboard Prompts tab) ---

// PromptAgent mirrors AgentKind in ../../workflows/agents.ts;
// the two are kept in lockstep by hand.
export type PromptAgent =
  | 'log_reviewer'
  | 'fix_implementer'
  | 'pr_maintainer'
  | 'linear_implementer'
  | 'linear_verifier'
  | 'request_router';

export interface PromptWire {
  repo: string; // '*' (all repos) or a lowercased owner/repo slug
  agent: PromptAgent;
  instructions: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  revision: string; // String(updated_at); echo back on save/delete for optimistic concurrency
}

// AgentPromptSegment mirrors PromptSegment in ../../types.ts. Only the editable
// segment can be overridden by an operator.
export interface AgentPromptSegment {
  key: string;
  title: string;
  editable: boolean;
  text: string;
}

export interface AgentCatalogEntry {
  agent: PromptAgent;
  label: string;
  workflow_type: WorkflowType;
  workflow_label: string;
  segments: AgentPromptSegment[]; // read-only sample of the built-in prompt, split into segments
}

/** GET `/dashboard/api/agents`. */
export interface PromptsResponse {
  agents: AgentCatalogEntry[];
  known_repos: string[];
  instructions: PromptWire[];
  max_instructions_length: number;
}

/** POST `/dashboard/api/agents/instructions` and `/dashboard/api/agents/instructions/delete`. */
export interface PromptActionResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  agents?: string[];
  instruction?: PromptWire;
  revision?: string;
  updated_at?: number;
  max_length?: number;
}
