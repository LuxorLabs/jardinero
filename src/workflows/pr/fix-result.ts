import type { FixNoPrOutcome, FixNoPrReason } from '../../types.js';
import { findMarkedJsonObject } from '../structured-output.js';
import { isPlainObject } from '../../platform/json.js';

export const FIX_RESULT_JSON_MARKER = 'FIX_RESULT_JSON:';

const NO_PR_REASONS = new Set<FixNoPrReason>([
  'false_positive',
  'unreproducible',
  'operational_issue',
  'outside_repo',
  'already_fixed',
  'unsafe_to_change',
  'insufficient_evidence',
  'needs_clarification',
  'too_large',
]);

export interface FixNoPrParseResult {
  outcome?: FixNoPrOutcome;
  rejectionReason?: string;
}

export function parseFixNoPrOutcome(text: string | undefined): FixNoPrParseResult {
  if (!text?.trim()) return {};

  const structuredOutput = findMarkedJsonObject(
    text,
    FIX_RESULT_JSON_MARKER,
    (value) => 'outcome' in value,
  );
  if (!structuredOutput) {
    return text.includes(FIX_RESULT_JSON_MARKER) ? { rejectionReason: 'marker_invalid_json' } : {};
  }

  if (structuredOutput.outcome !== 'no_pr') {
    return { rejectionReason: 'outcome_not_no_pr' };
  }

  const reason = stringField(structuredOutput, 'reason');
  if (!isNoPrReason(reason)) {
    return { rejectionReason: 'invalid_or_missing_reason' };
  }

  const evidence = normalizeEvidence(structuredOutput.evidence);
  if (evidence.length === 0) {
    return { rejectionReason: 'missing_evidence' };
  }

  return {
    outcome: {
      outcome: 'no_pr',
      reason,
      evidence,
      recommendedFollowup: stringField(
        structuredOutput,
        'recommended_followup',
        'recommendedFollowup',
      ),
      raw: structuredOutput,
    },
  };
}

function stringField(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function isNoPrReason(value: string | undefined): value is FixNoPrReason {
  return Boolean(value && NO_PR_REASONS.has(value as FixNoPrReason));
}

// normalizeEvidence keeps every entry that carries content, whatever its shape: the
// contract asks the agent for evidence, not for a string.
function normalizeEvidence(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.filter((item) => hasContent(item));
  if (hasContent(value)) return [value];
  return [];
}

// hasContent answers whether a value says anything, looking through the wrappers: an
// object or a list counts only when something inside it does.
function hasContent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((item) => hasContent(item));
  if (isPlainObject(value)) return Object.values(value).some((item) => hasContent(item));
  return value !== null && value !== undefined;
}
