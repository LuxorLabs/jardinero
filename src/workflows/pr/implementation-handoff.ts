import { type GrafanaTimeWindow, toAbsoluteGrafanaTimeRange } from '../../platform/grafana-url.js';
import { arrayValue, objectValue } from '../../platform/json.js';
import type {
  EvidenceLink,
  ImplementationHandoff,
  ImplementationHandoffExtraction,
  ImplementationHandoffRejection,
} from '../../types.js';
import { findMarkedJsonObject, findShapedJsonObject } from '../structured-output.js';
import type { ProblemSignature } from './implementation-pr-dedup.js';

export const HANDOFF_JSON_MARKER = 'HANDOFF_JSON:';
export const MISSING_HANDOFFS_REASON = 'structured_output_missing_implementation_handoffs';

export function parseImplementationHandoffs(
  text: string | undefined,
  sourceRunId: string,
  timeWindow: GrafanaTimeWindow,
): ImplementationHandoffExtraction {
  if (!text?.trim()) return { handoffs: [], rejections: [] };

  const structuredOutput = normalizeStructuredOutput(findStructuredOutput(text));
  if (!structuredOutput) {
    return {
      handoffs: [],
      rejections: text.includes(HANDOFF_JSON_MARKER)
        ? [{ index: 0, reason: 'marker_invalid_json' }]
        : [],
    };
  }
  if (!hasHandoffShape(structuredOutput)) {
    return {
      handoffs: [],
      rejections: [{ index: 0, reason: MISSING_HANDOFFS_REASON }],
      structuredOutput,
    };
  }

  const rawHandoffs = arrayValue(structuredOutput.implementation_handoffs);
  const verifiedIssuesByFingerprint = verifiedIssuesByFingerprintMap(structuredOutput);
  const handoffs: ImplementationHandoff[] = [];
  const rejections: ImplementationHandoffRejection[] = [];

  rawHandoffs.forEach((item, index) => {
    const raw = objectValue(item);
    if (!raw) {
      rejections.push({ index, reason: 'handoff_not_object' });
      return;
    }

    const normalized = normalizeHandoff(raw, sourceRunId, verifiedIssuesByFingerprint, timeWindow);
    if ('reason' in normalized) {
      rejections.push({ index, reason: normalized.reason });
      return;
    }
    handoffs.push(normalized.handoff);
  });

  return { handoffs, rejections, structuredOutput };
}

function findStructuredOutput(text: string): Record<string, unknown> | undefined {
  if (text.includes(HANDOFF_JSON_MARKER)) {
    return (
      findMarkedJsonObject(text, HANDOFF_JSON_MARKER, hasHandoffShape) ??
      findMarkedJsonObject(text, HANDOFF_JSON_MARKER, hasScanWithoutHandoffsShape)
    );
  }
  return (
    findShapedJsonObject(text, hasHandoffShape) ??
    findShapedJsonObject(text, hasScanWithoutHandoffsShape)
  );
}

// problemSignatureOf reads the fields that identify a problem out of the raw object the
// agent emitted, or nothing when it carries no fingerprint.
export function problemSignatureOf(raw: Record<string, unknown>): ProblemSignature | undefined {
  const fingerprint = stringField(raw, 'fingerprint');
  if (!fingerprint) return undefined;
  return {
    fingerprint,
    service: stringField(raw, 'service') ?? '',
    environment: stringField(raw, 'environment') ?? '',
    likelyFilesOrSymbols: stringArrayField(raw, 'likely_files_or_symbols', 'likelyFilesOrSymbols'),
  };
}

// normalizeStructuredOutput reads an omitted handoff array on an otherwise complete scan
// result as the empty array it stands for, which is a scan that found nothing.
export function normalizeStructuredOutput(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!hasScanWithoutHandoffsShape(value)) return value;
  return { ...value, implementation_handoffs: [] };
}

// A scan that answered in full carries its telemetry and both lists, so only the handoff
// array is missing; anything less is an answer we cannot read.
function hasScanWithoutHandoffsShape(
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> {
  return Boolean(
    value &&
      !('implementation_handoffs' in value) &&
      objectValue(value.telemetry_access) &&
      Array.isArray(value.candidates) &&
      Array.isArray(value.verified_issues),
  );
}

export function hasHandoffShape(
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> {
  return Boolean(value && Array.isArray(value.implementation_handoffs));
}

function normalizeHandoff(
  raw: Record<string, unknown>,
  sourceRunId: string,
  verifiedIssuesByFingerprint: Map<string, Record<string, unknown>>,
  timeWindow: GrafanaTimeWindow,
): { handoff: ImplementationHandoff } | { reason: string } {
  const repo = stringField(raw, 'repo');
  const service = stringField(raw, 'service');
  const environment = stringField(raw, 'environment');
  const fingerprint = stringField(raw, 'fingerprint');
  const severity = stringField(raw, 'severity');
  const confidence = numberField(raw, 'confidence');
  const userImpact = stringField(raw, 'user_impact', 'userImpact');
  const suspectedRootCause = stringField(raw, 'suspected_root_cause', 'suspectedRootCause');
  const sourceLogReviewRunId = sourceRunId;
  const verifiedIssue = fingerprint ? verifiedIssuesByFingerprint.get(fingerprint) : undefined;
  const readyForImplementation =
    booleanField(raw, 'ready_for_implementation', 'readyForImplementation') ??
    booleanField(verifiedIssue, 'ready_for_implementation', 'readyForImplementation');
  const dispatchBlockedByDryRun =
    booleanField(raw, 'dispatch_blocked_by_dry_run', 'dispatchBlockedByDryRun') ??
    booleanField(verifiedIssue, 'dispatch_blocked_by_dry_run', 'dispatchBlockedByDryRun') ??
    false;

  const missing = [
    ['repo', repo],
    ['service', service],
    ['environment', environment],
    ['fingerprint', fingerprint],
    ['severity', severity],
    ['confidence', confidence],
    ['user_impact', userImpact],
    ['suspected_root_cause', suspectedRootCause],
    ['ready_for_implementation', readyForImplementation],
  ]
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);

  if (missing.length > 0) return { reason: `missing_required_fields:${missing.join(',')}` };

  const evidence = arrayValue(field(raw, 'evidence'));
  const representativeLogs = arrayValue(
    field(raw, 'representative_sanitized_logs', 'representativeLogs'),
  );
  const evidenceLinks = evidenceLinksField(raw, timeWindow);
  const likelyFilesOrSymbols = stringArrayField(
    raw,
    'likely_files_or_symbols',
    'likelyFilesOrSymbols',
  );
  const reproductionSteps = stringArrayField(raw, 'reproduction_steps', 'reproductionSteps');
  const acceptanceCriteria = stringArrayField(raw, 'acceptance_criteria', 'acceptanceCriteria');
  const suggestedTests = stringArrayField(raw, 'suggested_tests', 'suggestedTests');

  if (evidence.length === 0) return { reason: 'missing_required_fields:evidence' };
  if (acceptanceCriteria.length === 0)
    return { reason: 'missing_required_fields:acceptance_criteria' };

  return {
    handoff: {
      repo: repo!,
      service: service!,
      environment: environment!,
      fingerprint: fingerprint!,
      severity: severity!,
      confidence: confidence!,
      userImpact: userImpact!,
      evidence,
      representativeLogs,
      evidenceLinks,
      suspectedRootCause: suspectedRootCause!,
      likelyFilesOrSymbols,
      reproductionSteps,
      acceptanceCriteria,
      suggestedTests,
      sourceLogReviewRunId,
      readyForImplementation: readyForImplementation!,
      dispatchBlockedByDryRun,
      raw,
    },
  };
}

function verifiedIssuesByFingerprintMap(
  structuredOutput: Record<string, unknown>,
): Map<string, Record<string, unknown>> {
  const issues = arrayValue(structuredOutput.verified_issues);
  const byFingerprint = new Map<string, Record<string, unknown>>();
  for (const issue of issues) {
    const raw = objectValue(issue);
    const fingerprint = raw ? stringField(raw, 'fingerprint') : undefined;
    if (raw && fingerprint) byFingerprint.set(fingerprint, raw);
  }
  return byFingerprint;
}

function field(raw: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in raw) return raw[key];
  }
  return undefined;
}

function stringField(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = field(raw, ...keys);
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberField(raw: Record<string, unknown>, ...keys: string[]): number | undefined {
  const value = field(raw, ...keys);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(
  raw: Record<string, unknown> | undefined,
  ...keys: string[]
): boolean | undefined {
  if (!raw) return undefined;
  const value = field(raw, ...keys);
  return typeof value === 'boolean' ? value : undefined;
}

function evidenceLinksField(
  raw: Record<string, unknown>,
  timeWindow: GrafanaTimeWindow,
): EvidenceLink[] {
  const links: EvidenceLink[] = [];
  for (const item of arrayValue(field(raw, 'evidence_links', 'evidenceLinks'))) {
    // Allow a bare string as a convenience; treat it as an unlabeled URL.
    if (typeof item === 'string') {
      const url = item.trim();
      if (url.length > 0) {
        links.push({ source: 'unknown', url: toAbsoluteGrafanaTimeRange(url, timeWindow) });
      }
      continue;
    }
    const obj = objectValue(item);
    if (!obj) continue;
    // Normalize source so downstream matching (e.g. source === 'grafana') stays
    // robust to handoffs emitting "Grafana"/"GRAFANA" or stray surrounding space.
    const source = (stringField(obj, 'source') ?? 'unknown').trim().toLowerCase();
    // Agents emit relative Grafana ranges (`now-90m`) despite instructions; pin the
    // range so the link still shows the incident when a reviewer opens it later.
    const rawLinkUrl = stringField(obj, 'url')?.trim();
    const url = rawLinkUrl ? toAbsoluteGrafanaTimeRange(rawLinkUrl, timeWindow) : undefined;
    const description = stringField(obj, 'description')?.trim();
    // A link with neither a URL nor a description carries no value to reviewers.
    if (!url && !description) continue;
    links.push({
      source,
      ...(url ? { url } : {}),
      ...(description ? { description } : {}),
    });
  }
  return links;
}

function stringArrayField(raw: Record<string, unknown>, ...keys: string[]): string[] {
  const value = field(raw, ...keys);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
