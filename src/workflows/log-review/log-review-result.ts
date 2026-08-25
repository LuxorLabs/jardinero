import { arrayValue, objectValue } from '../../platform/json.js';
import type { ImplementationHandoffRejection } from '../../types.js';
import {
  MISSING_HANDOFFS_REASON,
  hasHandoffShape,
  normalizeStructuredOutput,
} from '../pr/implementation-handoff.js';

/** Which contract the run broke; callers report the two classes differently. */
export type LogReviewValidationFailure = 'handoff_contract' | 'telemetry';

export interface LogReviewTelemetryValidation {
  ok: boolean;
  failure?: LogReviewValidationFailure;
  reason?: string;
  detail?: string;
}

export function validateLogReviewTelemetryAccess(
  rawStructuredOutput: Record<string, unknown> | undefined,
  handoffRejections: ImplementationHandoffRejection[] = [],
): LogReviewTelemetryValidation {
  const structuredOutput = normalizeStructuredOutput(rawStructuredOutput);
  if (!structuredOutput) {
    const parserRejection = handoffRejections[0];
    if (parserRejection) {
      return {
        ok: false,
        failure: 'handoff_contract',
        reason: parserRejection.reason,
        detail: `implementation handoff parser rejected index ${parserRejection.index}`,
      };
    }
    return { ok: false, failure: 'handoff_contract', reason: 'missing_handoff_json' };
  }

  // A payload the normalizer could not read is still a broken contract: without this
  // check a run that answered nothing would pass on telemetry evidence alone.
  if (!hasHandoffShape(structuredOutput)) {
    return { ok: false, failure: 'handoff_contract', reason: MISSING_HANDOFFS_REASON };
  }

  const telemetry = objectValue(structuredOutput.telemetry_access);
  if (!telemetry) {
    return { ok: false, failure: 'telemetry', reason: 'missing_telemetry_access' };
  }

  const status = stringValue(telemetry.status)?.toLowerCase();
  if (status !== 'ok') {
    return {
      ok: false,
      failure: 'telemetry',
      reason: status ? `telemetry_access_${status}` : 'telemetry_access_not_ok',
      detail: stringValue(telemetry.error) ?? stringValue(telemetry.reason),
    };
  }

  const queryValues = arrayValue(telemetry.queries);
  const queries = queryValues.length > 0 ? queryValues : arrayValue(telemetry.sources);
  if (queries.length === 0) {
    return { ok: false, failure: 'telemetry', reason: 'missing_telemetry_queries' };
  }

  return { ok: true };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
