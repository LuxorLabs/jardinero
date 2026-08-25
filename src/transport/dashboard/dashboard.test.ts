import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ApiContext } from '../context.js';
import { fakeRequest } from '../../testing/http.js';
import {
  dashboardRepoSlug,
  dashboardSafeError,
  expectedRevisionFromRequest,
  notifyDashboardChanged,
  subscribeDashboardEvents,
} from './dashboard.js';

// The two request handlers this module exports enter through HTTP and are owned by
// `test/functional/api/dashboard-*.test.ts`; what follows covers the helpers behind
// them.

describe('expectedRevisionFromRequest', () => {
  // The body wins over the header so a form post never has to set `If-Match`, and
  // the header is read in both its weak and quoted forms because that is what a
  // browser sends back from an ETag.
  const cases: Array<{
    name: string;
    body?: Record<string, unknown>;
    ifMatch?: string;
    want: string | undefined;
  }> = [
    {
      name: 'When the body carries a `revision` then should trim and return it',
      body: { revision: '  1700000000123  ' },
      want: '1700000000123',
    },
    {
      name: 'When the body `revision` is blank then should fall through to the header',
      body: { revision: '   ' },
      ifMatch: '"from-header"',
      want: 'from-header',
    },
    {
      name: 'When the body carries `updated_at` then should return it as a string',
      body: { updated_at: 1_700_000_000_123 },
      want: '1700000000123',
    },
    {
      name: 'When the body `updated_at` is not finite then should fall through to the header',
      body: { updated_at: Number.NaN },
      ifMatch: '"from-header"',
      want: 'from-header',
    },
    {
      name: 'When there is no revision anywhere then should return undefined',
      want: undefined,
    },
    {
      name: 'When the `if-match` header is blank then should return undefined',
      ifMatch: '   ',
      want: undefined,
    },
    {
      name: 'When the `if-match` header is weak then should drop the `W/` prefix and the quotes',
      ifMatch: 'W/"1700000000123"',
      want: '1700000000123',
    },
    {
      name: 'When the `if-match` header is quoted then should drop the quotes',
      ifMatch: '"1700000000123"',
      want: '1700000000123',
    },
    {
      name: 'When the `if-match` header is unquoted then should return it as it is',
      ifMatch: '1700000000123',
      want: '1700000000123',
    },
    {
      name: 'When the `if-match` header lists several tags then should use the first',
      ifMatch: '"first", "second"',
      want: 'first',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const request = fakeRequest({
        headers: testCase.ifMatch === undefined ? {} : { 'if-match': testCase.ifMatch },
      });

      assert.equal(expectedRevisionFromRequest(request, testCase.body ?? {}), testCase.want);
    });
  }
});

describe('dashboardRepoSlug', () => {
  const REQUIRED = /^repo is required and must be a GitHub owner\/repo slug$/;
  const SLUG = /^repo must be a GitHub owner\/repo slug$/;

  // A repo slug scopes stored operator guidance, so anything that is not a plain
  // owner/repo slug is refused here rather than matched loosely later.
  const cases: Array<{
    name: string;
    value: unknown;
    required?: boolean;
    wantValue: string | null;
    wantError?: RegExp;
  }> = [
    {
      name: 'When the repo is absent and optional then should return no value and no error',
      value: undefined,
      wantValue: null,
    },
    {
      name: 'When the repo is null and optional then should return no value and no error',
      value: null,
      wantValue: null,
    },
    {
      name: 'When the repo is empty and optional then should return no value and no error',
      value: '',
      wantValue: null,
    },
    {
      name: 'When the repo is absent and required then should return error',
      value: undefined,
      required: true,
      wantValue: null,
      wantError: REQUIRED,
    },
    {
      name: 'When the repo is not a string then should return error',
      value: 42,
      wantValue: null,
      wantError: /^repo must be an owner\/repo string$/,
    },
    {
      name: 'When the repo is only whitespace and optional then should return no value',
      value: '   ',
      wantValue: null,
    },
    {
      name: 'When the repo is only whitespace and required then should return error',
      value: '   ',
      required: true,
      wantValue: null,
      wantError: REQUIRED,
    },
    {
      name: 'When the repo has no owner then should return error',
      value: 'jardinero',
      wantValue: null,
      wantError: SLUG,
    },
    {
      name: 'When the repo has too many segments then should return error',
      value: 'acme/orchestrator/src',
      wantValue: null,
      wantError: SLUG,
    },
    {
      name: 'When the owner is not a valid slug then should return error',
      value: 'Luxor_Labs/jardinero',
      wantValue: null,
      wantError: SLUG,
    },
    {
      name: 'When the repo name ends in `.git` then should return error',
      value: 'acme/orchestrator.git',
      wantValue: null,
      wantError: SLUG,
    },
    {
      name: 'When the repo name is a dot segment then should return error',
      value: 'acme/..',
      wantValue: null,
      wantError: SLUG,
    },
    {
      name: 'When the repo is a valid slug then should return it',
      value: 'acme/orchestrator',
      wantValue: 'acme/orchestrator',
    },
    {
      name: 'When the repo is padded then should return it trimmed',
      value: '  acme/orchestrator  ',
      wantValue: 'acme/orchestrator',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const result = dashboardRepoSlug(testCase.value, { required: testCase.required });

      assert.equal(result.value, testCase.wantValue);
      if (testCase.wantError) assert.match(result.error ?? '', testCase.wantError);
      else assert.equal(result.error, undefined);
    });
  }
});

describe('dashboardSafeError', () => {
  // Whatever reaches the dashboard is rendered to an operator, so a credential that
  // leaked into an error message must not survive the trip.
  const cases: Array<{ name: string; error: unknown; fallback?: string; want: string }> = [
    {
      name: 'When the error is an `Error` then should use its message',
      error: new Error('run not found'),
      want: 'run not found',
    },
    {
      name: 'When the error is a string then should use it',
      error: 'plain failure',
      want: 'plain failure',
    },
    {
      name: 'When the error is neither then should use the fallback',
      error: { code: 500 },
      want: 'dashboard_request_failed',
    },
    {
      name: 'When the message sanitizes to nothing then should use the fallback',
      error: new Error('   '),
      want: 'dashboard_request_failed',
    },
    {
      name: 'When a fallback is given then should use it instead of the default',
      error: null,
      fallback: 'retry_failed',
      want: 'retry_failed',
    },
    {
      name: 'When the message carries a bearer token then should redact it',
      error: new Error('rejected: Bearer ghp_abcdefabcdef'),
      want: 'rejected: Bearer [redacted]',
    },
    {
      name: 'When the message carries an assignment to a secret then should redact its value',
      error: new Error('GITHUB_TOKEN=ghp_abcdefabcdef missing'),
      want: 'GITHUB_TOKEN=[redacted] missing',
    },
    {
      name: 'When the message carries an authorization header then should redact it',
      error: new Error('authorization: Basic dXNlcjpwYXNz'),
      want: 'authorization: [redacted]',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(dashboardSafeError(testCase.error, testCase.fallback), testCase.want);
    });
  }
});

describe('subscribeDashboardEvents', () => {
  test('When several listeners subscribe then should notify each of them', () => {
    const context = eventContext();
    const seen: string[] = [];
    subscribeDashboardEvents(context, () => seen.push('first'));
    subscribeDashboardEvents(context, () => seen.push('second'));

    notifyDashboardChanged(context);

    assert.deepEqual(seen, ['first', 'second']);
  });

  // The SSE endpoint unsubscribes when the client disconnects, so a stale listener
  // must not keep receiving events for a closed connection.
  test('When the returned unsubscribe is called then should stop notifying it', () => {
    const context = eventContext();
    let calls = 0;
    const unsubscribe = subscribeDashboardEvents(context, () => {
      calls += 1;
    });

    unsubscribe();
    notifyDashboardChanged(context);

    assert.equal(calls, 0);
  });

  test('When two contexts subscribe then should keep their listeners apart', () => {
    const first = eventContext();
    const second = eventContext();
    let firstCalls = 0;
    let secondCalls = 0;
    subscribeDashboardEvents(first, () => {
      firstCalls += 1;
    });
    subscribeDashboardEvents(second, () => {
      secondCalls += 1;
    });

    notifyDashboardChanged(first);

    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 0);
  });
});

describe('notifyDashboardChanged', () => {
  test('When no listener ever subscribed then should do nothing', () => {
    notifyDashboardChanged(eventContext());
  });
});

// The listener registry is keyed by context identity, so a bare object is enough.
function eventContext(): ApiContext {
  return {} as ApiContext;
}
