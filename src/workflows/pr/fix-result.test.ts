import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { FIX_RESULT_JSON_MARKER, parseFixNoPrOutcome } from './fix-result.js';

describe('parseFixNoPrOutcome', () => {
  const cases: Array<{
    name: string;
    text: string;
    wantRejection?: string;
    wantReason?: string;
    wantEvidence?: string[];
    wantEvidenceCount?: number;
    wantFollowup?: string;
  }> = [
    {
      name: 'When no marker is present then should ignore the payload',
      text: [
        'This log payload was captured during validation:',
        '```json',
        JSON.stringify({
          outcome: 'no_pr',
          reason: 'false_positive',
          evidence: ['Incidental payload, not a worker declaration.'],
        }),
        '```',
      ].join('\n'),
    },
    {
      name: 'When the marked object is not a fix result then should return error',
      text: `${FIX_RESULT_JSON_MARKER}\n${JSON.stringify({ note: 'not a fix result' })}`,
      wantRejection: 'outcome_not_no_pr',
    },
    {
      name: 'When the reason is not a known value then should return error',
      text: marked({ outcome: 'no_pr', reason: 'maybe_later', evidence: ['Checked logs.'] }),
      wantRejection: 'invalid_or_missing_reason',
    },
    {
      name: 'When the evidence list is empty then should return error',
      text: marked({ outcome: 'no_pr', reason: 'false_positive', evidence: [] }),
      wantRejection: 'missing_evidence',
    },
    {
      name: 'When the evidence string is blank then should return error',
      text: marked({ outcome: 'no_pr', reason: 'false_positive', evidence: '   ' }),
      wantRejection: 'missing_evidence',
    },
    {
      name: 'When every evidence entry is blank then should return error',
      text: marked({ outcome: 'no_pr', reason: 'false_positive', evidence: ['', '   '] }),
      wantRejection: 'missing_evidence',
    },
    {
      name: 'When the evidence entries are objects then should accept them',
      text: marked({
        outcome: 'no_pr',
        reason: 'already_fixed',
        evidence: [
          { type: 'commit_history', detail: '4956e0a removed the lock and HEAD has it.' },
          { type: 'code_validation', detail: 'The reconciler no longer takes the lock.' },
        ],
      }),
      wantReason: 'already_fixed',
      wantEvidenceCount: 2,
    },
    {
      name: 'When an evidence object holds a number then should accept it',
      text: marked({ outcome: 'no_pr', reason: 'already_fixed', evidence: [{ status_code: 403 }] }),
      wantReason: 'already_fixed',
      wantEvidenceCount: 1,
    },
    {
      name: 'When every value of an evidence object is blank then should drop it',
      text: marked({ outcome: 'no_pr', reason: 'already_fixed', evidence: [{ detail: '   ' }] }),
      wantRejection: 'missing_evidence',
    },
    {
      name: 'When an evidence object is empty then should drop it',
      text: marked({ outcome: 'no_pr', reason: 'already_fixed', evidence: [{}] }),
      wantRejection: 'missing_evidence',
    },
    {
      name: 'When the evidence is a string then should accept it as one entry',
      text: marked({
        outcome: 'no_pr',
        reason: 'insufficient_evidence',
        evidence: 'Timeout config is already passed to the pool; the fix is in deployed DB config.',
        recommended_followup: 'Check the deployed database connectivity and timeout value.',
      }),
      wantReason: 'insufficient_evidence',
      wantEvidence: [
        'Timeout config is already passed to the pool; the fix is in deployed DB config.',
      ],
      wantFollowup: 'Check the deployed database connectivity and timeout value.',
    },
    {
      name: 'When the evidence mixes blank and real entries then should keep the real ones',
      text: marked({
        outcome: 'no_pr',
        reason: 'false_positive',
        evidence: ['   ', 'Latency spike matches a provider incident, not repository code.'],
      }),
      wantReason: 'false_positive',
      wantEvidence: ['Latency spike matches a provider incident, not repository code.'],
    },
    {
      name: 'When a fenced payload follows the marker then should parse it',
      text: [
        'Validated the handoff; no code change is warranted.',
        FIX_RESULT_JSON_MARKER,
        '```json',
        JSON.stringify({
          outcome: 'no_pr',
          reason: 'operational_issue',
          evidence: ['Stripe key lacks required permission; code path behaves as configured.'],
          recommended_followup: 'Rotate the restricted key with subscription write permission.',
        }),
        '```',
      ].join('\n'),
      wantReason: 'operational_issue',
      wantEvidence: ['Stripe key lacks required permission; code path behaves as configured.'],
      wantFollowup: 'Rotate the restricted key with subscription write permission.',
    },
    {
      // Agents restate the instruction and print unrelated JSON before the real
      // block, so the first parseable object after the first mention is not it.
      name: 'When unrelated json follows a restated marker then should find the real payload',
      text: [
        `I will end my response with ${FIX_RESULT_JSON_MARKER} as instructed.`,
        'Config observed during validation:',
        '```json',
        JSON.stringify({ retries: 3, timeout_ms: 5000 }),
        '```',
        FIX_RESULT_JSON_MARKER,
        JSON.stringify({
          outcome: 'no_pr',
          reason: 'false_positive',
          evidence: ['Latency spike matches a provider incident, not repository code.'],
        }),
      ].join('\n'),
      wantReason: 'false_positive',
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const result = parseFixNoPrOutcome(c.text);

      assert.equal(result.rejectionReason, c.wantRejection);
      if (c.wantReason === undefined) {
        assert.equal(result.outcome, undefined);
        return;
      }
      assert.equal(result.outcome?.reason, c.wantReason);
      if (c.wantEvidence) assert.deepEqual(result.outcome?.evidence, c.wantEvidence);
      if (c.wantEvidenceCount !== undefined) {
        assert.equal(result.outcome?.evidence.length, c.wantEvidenceCount);
      }
      if (c.wantFollowup) assert.equal(result.outcome?.recommendedFollowup, c.wantFollowup);
    });
  }
});

function marked(payload: Record<string, unknown>): string {
  return `${FIX_RESULT_JSON_MARKER} ${JSON.stringify(payload)}`;
}
