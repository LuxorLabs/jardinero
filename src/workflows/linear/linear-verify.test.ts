import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  LINEAR_VERIFY_JSON_MARKER,
  type LinearVerification,
  linearVerificationAccepts,
  parseLinearVerification,
} from './linear-verify.js';

describe('parseLinearVerification', () => {
  const rejectionCases: Array<{ name: string; text: string | undefined; wantReason?: string }> = [
    {
      name: 'When the text is undefined then should return no verification',
      text: undefined,
    },
    {
      name: 'When the text is empty then should return no verification',
      text: '',
    },
    {
      name: 'When the marker is absent then should return no verification',
      text: 'All checks passed, accepting.',
    },
    {
      name: 'When the marked json is invalid then should return error',
      text: `${LINEAR_VERIFY_JSON_MARKER} {not json`,
      wantReason: 'marker_invalid_json',
    },
    {
      name: 'When the verdict is missing then should return error',
      text: markedPayload({ verdict: undefined }),
      wantReason: 'invalid_or_missing_verdict',
    },
    {
      name: 'When the verdict is not accept or reject then should return error',
      text: markedPayload({ verdict: 'maybe' }),
      wantReason: 'invalid_or_missing_verdict',
    },
    {
      name: 'When the criteria are not an array then should return error',
      text: markedPayload({ criteria: 'all good' }),
      wantReason: 'invalid_criteria',
    },
    {
      name: 'When a criterion status is unknown then should return error',
      text: markedPayload({ criteria: [{ text: 'x', status: 'maybe' }] }),
      wantReason: 'invalid_criteria',
    },
    {
      name: 'When a criterion has no text then should return error',
      text: markedPayload({ criteria: [{ status: 'passed' }] }),
      wantReason: 'invalid_criteria',
    },
    {
      name: 'When the criteria are absent then should return error',
      text: markedPayload({ criteria: undefined }),
      wantReason: 'missing_criteria',
    },
    {
      name: 'When the criteria are empty then should return error',
      text: markedPayload({ criteria: [] }),
      wantReason: 'missing_criteria',
    },
    {
      name: 'When the issues are not an array then should return error',
      text: markedPayload({ issues: 'none' }),
      wantReason: 'invalid_issues',
    },
    {
      name: 'When an issue entry is not a string then should return error',
      text: markedPayload({ issues: [123] }),
      wantReason: 'invalid_issues',
    },
  ];

  for (const c of rejectionCases) {
    test(c.name, () => {
      const result = parseLinearVerification(c.text);

      assert.equal(result.verification, undefined);
      assert.equal(result.rejectionReason, c.wantReason);
    });
  }

  test('When the payload is valid then should validate successfully', () => {
    const result = parseLinearVerification(markedPayload());

    assert.equal(result.rejectionReason, undefined);
    assert.equal(result.verification?.verdict, 'accept');
    assert.equal(result.verification?.followedProcedures, true);
    assert.deepEqual(result.verification?.criteria, [
      { text: 'GET /healthz returns 200', status: 'passed', evidence: 'curl exit 0' },
    ]);
    assert.deepEqual(result.verification?.issues, []);
  });

  test('When the verdict is reject with issues then should validate successfully', () => {
    const result = parseLinearVerification(
      markedPayload({
        verdict: 'reject',
        criteria: [{ text: 'GET /healthz returns 200', status: 'failed' }],
        issues: ['GET /healthz returns 404.'],
      }),
    );

    assert.equal(result.rejectionReason, undefined);
    assert.equal(result.verification?.verdict, 'reject');
    assert.deepEqual(result.verification?.issues, ['GET /healthz returns 404.']);
    assert.equal(result.verification?.criteria[0]?.status, 'failed');
  });

  test('When the followed flag is missing then should fail closed', () => {
    const result = parseLinearVerification(markedPayload({ followed_procedures: undefined }));

    assert.equal(result.verification?.followedProcedures, false);
  });

  // snake_case is the documented contract, but the verifier may paraphrase it as
  // camelCase; the parser accepts either spelling for the followed flag.
  test('When the followed flag is camel case then should validate successfully', () => {
    const result = parseLinearVerification(
      markedPayload({ followed_procedures: undefined, followedProcedures: true }),
    );

    assert.equal(result.rejectionReason, undefined);
    assert.equal(result.verification?.followedProcedures, true);
  });

  test('When the payload is in a fenced block then should validate successfully', () => {
    const text = [
      'Summary of the review.',
      LINEAR_VERIFY_JSON_MARKER,
      '```json',
      JSON.stringify({
        verdict: 'accept',
        criteria: [{ text: 'GET /healthz returns 200', status: 'passed' }],
        issues: [],
        followed_procedures: true,
      }),
      '```',
    ].join('\n');

    const result = parseLinearVerification(text);

    assert.equal(result.rejectionReason, undefined);
    assert.equal(result.verification?.verdict, 'accept');
    assert.equal(result.verification?.followedProcedures, true);
  });

  test('When the marker is restated in narration then should parse the real payload', () => {
    const text = [
      `I will end with ${LINEAR_VERIFY_JSON_MARKER} as instructed.`,
      'Captured response body:',
      '```json',
      JSON.stringify({ uptime_seconds: 42 }),
      '```',
      markedPayload(),
    ].join('\n');

    const result = parseLinearVerification(text);

    assert.equal(result.rejectionReason, undefined);
    assert.equal(result.verification?.verdict, 'accept');
  });
});

describe('linearVerificationAccepts', () => {
  const cases: Array<{ name: string; overrides: Partial<LinearVerification>; want: boolean }> = [
    {
      name: 'When every criterion passed then should succeed',
      overrides: {},
      want: true,
    },
    {
      name: 'When the verdict is reject then should return false',
      overrides: { verdict: 'reject' },
      want: false,
    },
    {
      name: 'When an issue is open then should return false',
      overrides: { issues: ['GET /healthz returns 404.'] },
      want: false,
    },
    {
      name: 'When a criterion failed then should return false',
      overrides: { criteria: [{ text: 'GET /healthz returns 200', status: 'failed' }] },
      want: false,
    },
    {
      name: 'When a criterion is untested then should return false',
      overrides: { criteria: [{ text: 'GET /healthz returns 200', status: 'untested' }] },
      want: false,
    },
    {
      name: 'When the criteria are empty then should return false',
      overrides: { criteria: [] },
      want: false,
    },
    {
      name: 'When the procedures were not followed then should return false',
      overrides: { followedProcedures: false },
      want: false,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(linearVerificationAccepts(verification(c.overrides)), c.want);
    });
  }
});

function markedPayload(overrides: Record<string, unknown> = {}): string {
  return `${LINEAR_VERIFY_JSON_MARKER} ${JSON.stringify({
    verdict: 'accept',
    criteria: [{ text: 'GET /healthz returns 200', status: 'passed', evidence: 'curl exit 0' }],
    issues: [],
    followed_procedures: true,
    ...overrides,
  })}`;
}

function verification(overrides: Partial<LinearVerification> = {}): LinearVerification {
  return {
    verdict: 'accept',
    criteria: [{ text: 'GET /healthz returns 200', status: 'passed' }],
    issues: [],
    followedProcedures: true,
    raw: {},
    ...overrides,
  };
}
