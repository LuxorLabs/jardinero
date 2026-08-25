import type { LinearVerification } from './workflows/linear/linear-verify.js';

export type Workflow = 'log_review' | 'pr_maintain' | 'fix_implement' | 'linear' | 'request_router';
export interface WorkerEvent {
  type: string;
  timestamp: number;
  message?: string;
  data?: Record<string, unknown>;
}

export interface WorkerResult {
  status: 'succeeded' | 'failed' | 'aborted' | 'skipped';
  costUsd: number | null;
  summary: string;
  sandboxSessionId?: string;
  openedPrUrl?: string;
  noPrOutcome?: FixNoPrOutcome;
  implementationHandoffs?: ImplementationHandoff[];
  implementationHandoffRejections?: ImplementationHandoffRejection[];
  // Structured verdict produced by a linear verify-role run.
  linearVerification?: LinearVerification;
  artifacts?: Record<string, string>;
  error?: string;
}

export type FixNoPrReason =
  | 'false_positive'
  | 'unreproducible'
  | 'operational_issue'
  | 'outside_repo'
  | 'already_fixed'
  | 'unsafe_to_change'
  | 'insufficient_evidence'
  // Linear-issue outcomes: the issue is underspecified, or too large for a
  // single implementation run and should be broken down.
  | 'needs_clarification'
  | 'too_large';

export interface FixNoPrOutcome {
  outcome: 'no_pr';
  reason: FixNoPrReason;
  evidence: unknown[];
  recommendedFollowup?: string;
  raw: Record<string, unknown>;
}

// PromptSegment is one ordered piece of a worker's prompt. An `editable` segment can be
// replaced by an operator's guidance override; a `locked` one cannot.
export interface PromptSegment {
  key: string;
  title: string;
  editable: boolean;
  text: string;
}

export interface EvidenceLink {
  // Where the signal came from, e.g. "grafana", "sentry", "datadog", "deploy", "trace".
  source: string;
  // Direct, clickable URL when one is available (Grafana Explore/dashboard/panel
  // deep link, error-tracker permalink, etc.).
  url?: string;
  // What the link shows or, when no URL exists, the locating details a dev needs to
  // find the signal (query, time window, trace id, fingerprint, …).
  description?: string;
}

export interface ImplementationHandoff {
  repo: string;
  service: string;
  environment: string;
  fingerprint: string;
  severity: string;
  confidence: number;
  userImpact: string;
  evidence: unknown[];
  representativeLogs: unknown[];
  // Links back to the telemetry that triggered the handoff. Carried into the fix
  // PR so reviewers can replay the exact Grafana query / dashboard, or — for a
  // non-Grafana source — follow the available link or locating details.
  evidenceLinks: EvidenceLink[];
  suspectedRootCause: string;
  likelyFilesOrSymbols: string[];
  reproductionSteps: string[];
  acceptanceCriteria: string[];
  suggestedTests: string[];
  sourceLogReviewRunId: string;
  readyForImplementation: boolean;
  dispatchBlockedByDryRun: boolean;
  raw: Record<string, unknown>;
}

export interface ImplementationHandoffRejection {
  index: number;
  reason: string;
}

// RejectedImplementationPr is a fix pull request a human rejected. The handoff is
// stored to suppress duplicate fixes for the same error signal.
export interface RejectedImplementationPr {
  repo: string;
  prNumber: number;
  prUrl?: string;
  sourceRunId?: string;
  decidedAt: number;
  reason?: string;
  handoff: ImplementationHandoff;
}

export interface ImplementationHandoffExtraction {
  handoffs: ImplementationHandoff[];
  rejections: ImplementationHandoffRejection[];
  structuredOutput?: Record<string, unknown>;
}
