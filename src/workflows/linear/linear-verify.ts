import { findMarkedJsonObject } from '../structured-output.js';

export const LINEAR_VERIFY_JSON_MARKER = 'LINEAR_VERIFY_JSON:';

export type LinearCriterionStatus = 'passed' | 'failed' | 'untested';

export interface LinearVerificationCriterion {
  text: string;
  status: LinearCriterionStatus;
  evidence?: string;
}

export interface LinearVerification {
  verdict: 'accept' | 'reject';
  criteria: LinearVerificationCriterion[];
  issues: string[];
  followedProcedures: boolean;
  raw: Record<string, unknown>;
}

export interface LinearVerifyParseResult {
  verification?: LinearVerification;
  rejectionReason?: string;
}

const CRITERION_STATUSES = new Set<LinearCriterionStatus>(['passed', 'failed', 'untested']);

export function parseLinearVerification(text: string | undefined): LinearVerifyParseResult {
  if (!text?.trim()) return {};

  const raw = findMarkedJsonObject(
    text,
    LINEAR_VERIFY_JSON_MARKER,
    (value) => 'verdict' in value || 'criteria' in value,
  );
  if (!raw) {
    return text.includes(LINEAR_VERIFY_JSON_MARKER)
      ? { rejectionReason: 'marker_invalid_json' }
      : {};
  }

  const verdict = raw.verdict;
  if (verdict !== 'accept' && verdict !== 'reject') {
    return { rejectionReason: 'invalid_or_missing_verdict' };
  }

  const criteria = parseCriteria(raw.criteria);
  if (criteria === undefined) return { rejectionReason: 'invalid_criteria' };
  if (criteria.length === 0) return { rejectionReason: 'missing_criteria' };

  const issues = raw.issues === undefined ? [] : parseIssues(raw.issues);
  if (issues === undefined) return { rejectionReason: 'invalid_issues' };

  return {
    verification: {
      verdict,
      criteria,
      issues,
      // Fail-closed: a verifier that does not affirm it followed the procedure
      // cannot accept, so a missing flag is treated as false.
      followedProcedures: (raw.followed_procedures ?? raw.followedProcedures) === true,
      raw,
    },
  };
}

// linearVerificationAccepts decides on what the verifier reported: an untested
// criterion or any open issue rejects, so it fails closed.
export function linearVerificationAccepts(verification: LinearVerification): boolean {
  return (
    verification.verdict === 'accept' &&
    verification.followedProcedures &&
    verification.issues.length === 0 &&
    verification.criteria.length > 0 &&
    verification.criteria.every((criterion) => criterion.status === 'passed')
  );
}

function parseCriteria(value: unknown): LinearVerificationCriterion[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const criteria: LinearVerificationCriterion[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    const status = record.status;
    if (
      !text ||
      typeof status !== 'string' ||
      !CRITERION_STATUSES.has(status as LinearCriterionStatus)
    ) {
      return undefined;
    }
    criteria.push({
      text,
      status: status as LinearCriterionStatus,
      ...(typeof record.evidence === 'string' && record.evidence.trim()
        ? { evidence: record.evidence }
        : {}),
    });
  }
  return criteria;
}

function parseIssues(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    if (item.trim()) issues.push(item);
  }
  return issues;
}
