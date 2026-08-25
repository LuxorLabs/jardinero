import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { validateLogReviewTelemetryAccess } from './log-review-result.js';

describe('validateLogReviewTelemetryAccess', () => {
  const cases: Array<{
    name: string;
    structuredOutput: Record<string, unknown> | undefined;
    rejections?: Array<{ index: number; reason: string }>;
    want: Record<string, unknown>;
  }> = [
    {
      name: 'When `handoff_json` is missing then should return error',
      structuredOutput: undefined,
      want: { ok: false, failure: 'handoff_contract', reason: 'missing_handoff_json' },
    },
    {
      // A parser rejection is the more specific cause, so it outranks the generic
      // missing-handoff reason the caller would otherwise report.
      name: 'When the parser rejected a handoff then should report the rejection reason',
      structuredOutput: undefined,
      rejections: [{ index: 0, reason: 'marker_invalid_json' }],
      want: {
        ok: false,
        failure: 'handoff_contract',
        reason: 'marker_invalid_json',
        detail: 'implementation handoff parser rejected index 0',
      },
    },
    {
      name: 'When telemetry access is missing then should return error',
      structuredOutput: { implementation_handoffs: [] },
      want: { ok: false, failure: 'telemetry', reason: 'missing_telemetry_access' },
    },
    {
      name: 'When telemetry access is blocked then should return error',
      structuredOutput: {
        telemetry_access: { status: 'blocked', error: 'Grafana MCP is not logged in.' },
        implementation_handoffs: [],
      },
      want: {
        ok: false,
        failure: 'telemetry',
        reason: 'telemetry_access_blocked',
        detail: 'Grafana MCP is not logged in.',
      },
    },
    {
      name: 'When telemetry queries are missing then should return error',
      structuredOutput: { telemetry_access: { status: 'ok' }, implementation_handoffs: [] },
      want: { ok: false, failure: 'telemetry', reason: 'missing_telemetry_queries' },
    },
    {
      // A scan that answered in full and found nothing is not a broken contract.
      name: 'When a complete scan omits handoffs then should validate successfully',
      structuredOutput: {
        telemetry_access: {
          status: 'ok',
          queries: ['{namespace="production", app="api"} |= "error"'],
        },
        candidates: [],
        verified_issues: [],
      },
      want: { ok: true },
    },
    {
      name: 'When the structured output omits handoffs and telemetry then should return error',
      structuredOutput: { candidates: [], verified_issues: [] },
      want: {
        ok: false,
        failure: 'handoff_contract',
        reason: 'structured_output_missing_implementation_handoffs',
      },
    },
    {
      name: 'When the handoffs field is not an array then should return error',
      structuredOutput: {
        telemetry_access: { status: 'ok', queries: ['{app="api"} |= "error"'] },
        implementation_handoffs: 'none',
      },
      want: {
        ok: false,
        failure: 'handoff_contract',
        reason: 'structured_output_missing_implementation_handoffs',
      },
    },
    {
      name: 'When an empty handoff list carries query evidence then should validate successfully',
      structuredOutput: {
        telemetry_access: {
          status: 'ok',
          queries: [
            {
              source: 'grafana_loki',
              query: '{namespace="production", app="api"} |= "error"',
              result_summary: 'No new errors found.',
            },
          ],
        },
        candidates: [],
        verified_issues: [],
        implementation_handoffs: [],
      },
      want: { ok: true },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.deepEqual(validateLogReviewTelemetryAccess(c.structuredOutput, c.rejections), c.want);
    });
  }
});
