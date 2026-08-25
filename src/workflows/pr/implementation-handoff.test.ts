import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  HANDOFF_JSON_MARKER,
  hasHandoffShape,
  normalizeStructuredOutput,
  parseImplementationHandoffs,
  problemSignatureOf,
} from './implementation-handoff.js';

const TIME_WINDOW = { fromAnchorMs: 1_750_000_000_000, toAnchorMs: 1_750_000_600_000 };

describe('parseImplementationHandoffs', () => {
  test('When a fenced payload follows the marker then should extract the handoff', () => {
    const output = [
      'Found one verified issue.',
      HANDOFF_JSON_MARKER,
      '```json',
      JSON.stringify({ candidates: [], verified_issues: [], implementation_handoffs: [handoff()] }),
      '```',
    ].join('\n');

    const result = parseImplementationHandoffs(output, 'source-run-1', TIME_WINDOW);

    assert.equal(result.handoffs.length, 1);
    assert.equal(result.rejections.length, 0);
    assert.equal(result.handoffs[0].repo, 'ExampleOrg/example-service');
    assert.equal(result.handoffs[0].sourceLogReviewRunId, 'source-run-1');
    // evidence_links is optional; absence must not reject the handoff.
    assert.deepEqual(result.handoffs[0].evidenceLinks, []);
  });

  test('When evidence links are present then should carry the usable ones through', () => {
    const output = marked({
      implementation_handoffs: [
        handoff({
          evidence_links: [
            {
              source: 'grafana',
              url: 'https://grafana.example.com/explore?left=...',
              description: 'engine 5xx, last 1h',
            },
            { source: 'deploy', description: 'deploy abc123 at 14:02 UTC' },
            'https://grafana.example.com/d/dashboard',
            { source: 'grafana' },
          ],
        }),
      ],
    });

    const result = parseImplementationHandoffs(output, 'source-run-1', TIME_WINDOW);

    const links = result.handoffs[0].evidenceLinks;
    // The last entry has neither url nor description and is dropped.
    assert.equal(links.length, 3);
    assert.deepEqual(links[0], {
      source: 'grafana',
      url: 'https://grafana.example.com/explore?left=...',
      description: 'engine 5xx, last 1h',
    });
    assert.deepEqual(links[1], { source: 'deploy', description: 'deploy abc123 at 14:02 UTC' });
    assert.deepEqual(links[2], {
      source: 'unknown',
      url: 'https://grafana.example.com/d/dashboard',
    });
  });

  test('When an evidence link is padded then should normalize the source and trim it', () => {
    const output = marked({
      implementation_handoffs: [
        handoff({
          evidence_links: [
            {
              source: '  GRAFANA ',
              url: '  https://grafana.example.com/explore?left=...  ',
              description: '  engine 5xx, last 1h  ',
            },
          ],
        }),
      ],
    });

    const result = parseImplementationHandoffs(output, 'source-run-1', TIME_WINDOW);

    // source is lowercased and trimmed so downstream source === 'grafana' matching
    // stays robust; url and description are trimmed for clean rendered Markdown.
    assert.deepEqual(result.handoffs[0].evidenceLinks[0], {
      source: 'grafana',
      url: 'https://grafana.example.com/explore?left=...',
      description: 'engine 5xx, last 1h',
    });
  });

  test('When a grafana link uses a relative range then should rewrite it to absolute', () => {
    const panes = { ljh: { datasource: 'ds-uid', range: { from: 'now-90m', to: 'now' } } };
    const relativeUrl = `https://grafana.example.com/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}&orgId=1`;
    const output = marked({
      implementation_handoffs: [
        handoff({
          evidence_links: [{ source: 'grafana', url: relativeUrl, description: 'engine 5xx' }],
        }),
      ],
    });

    const result = parseImplementationHandoffs(output, 'source-run-1', TIME_WINDOW);

    const link = result.handoffs[0].evidenceLinks[0];
    assert.ok(link.url);
    const rewrittenPanes = new URL(link.url).searchParams.get('panes');
    assert.ok(rewrittenPanes);
    // from anchors at run start, to at parse time, so the window covers the whole run.
    assert.deepEqual(JSON.parse(rewrittenPanes).ljh.range, {
      from: '1749994600000',
      to: '1750000600000',
    });
  });

  test('When one handoff is malformed then should keep its valid siblings', () => {
    const output = marked({
      implementation_handoffs: [
        { repo: 'ExampleOrg/example-service' },
        handoff({ fingerprint: 'fp-valid-2' }),
      ],
    });

    const result = parseImplementationHandoffs(output, 'source-run-1', TIME_WINDOW);

    assert.equal(result.handoffs.length, 1);
    assert.equal(result.handoffs[0].fingerprint, 'fp-valid-2');
    assert.equal(result.rejections.length, 1);
    assert.match(result.rejections[0].reason, /missing_required_fields/);
  });

  test('When the marker carries invalid json then should record a rejection', () => {
    const result = parseImplementationHandoffs(
      `${HANDOFF_JSON_MARKER} not json`,
      'source-run-1',
      TIME_WINDOW,
    );

    assert.equal(result.handoffs.length, 0);
    assert.deepEqual(result.rejections, [{ index: 0, reason: 'marker_invalid_json' }]);
    assert.equal(result.structuredOutput, undefined);
  });

  test('When a complete scan omits handoffs then should read it as a scan that found nothing', () => {
    const structuredOutput = {
      telemetry_access: {
        status: 'ok',
        queries: ['{namespace="production", app="api"} |= "error"'],
      },
      candidates: [],
      verified_issues: [],
    };

    const result = parseImplementationHandoffs(
      marked(structuredOutput),
      'source-run-1',
      TIME_WINDOW,
    );

    assert.equal(result.handoffs.length, 0);
    assert.deepEqual(result.rejections, []);
    assert.deepEqual(result.structuredOutput, {
      ...structuredOutput,
      implementation_handoffs: [],
    });
  });

  test('When an incomplete payload omits handoffs then should reject it', () => {
    const result = parseImplementationHandoffs(
      marked({ telemetry_access: { status: 'ok' }, candidates: [] }),
      'source-run-1',
      TIME_WINDOW,
    );

    assert.deepEqual(result.rejections, [
      { index: 0, reason: 'structured_output_missing_implementation_handoffs' },
    ]);
  });

  test('When a scan summary precedes the handoffs then should prefer the handoff block', () => {
    const output = [
      HANDOFF_JSON_MARKER,
      JSON.stringify({ telemetry_access: { status: 'ok' }, candidates: [], verified_issues: [] }),
      JSON.stringify({ implementation_handoffs: [handoff({ fingerprint: 'after-summary' })] }),
    ].join('\n');

    const result = parseImplementationHandoffs(output, 'source-run-1', TIME_WINDOW);

    assert.equal(result.handoffs.length, 1);
    assert.equal(result.handoffs[0].fingerprint, 'after-summary');
    assert.deepEqual(result.rejections, []);
  });

  test('When metadata json precedes the payload then should find the handoff block', () => {
    const output = [
      HANDOFF_JSON_MARKER,
      '```json',
      JSON.stringify({ metadata: { note: 'not the handoff' } }),
      '```',
      '```json',
      JSON.stringify({ implementation_handoffs: [handoff({ fingerprint: 'after-metadata' })] }),
      '```',
    ].join('\n');

    const result = parseImplementationHandoffs(output, 'source-run-1', TIME_WINDOW);

    assert.equal(result.handoffs.length, 1);
    assert.equal(result.handoffs[0].fingerprint, 'after-metadata');
  });

  test('When the marker is restated earlier then should anchor on the last occurrence', () => {
    const output = [
      `As instructed, the report ends with ${HANDOFF_JSON_MARKER} and the structured payload.`,
      'Queried config for context:',
      '```json',
      JSON.stringify({ lookback_min: 60 }),
      '```',
      HANDOFF_JSON_MARKER,
      JSON.stringify({ candidates: [], verified_issues: [], implementation_handoffs: [handoff()] }),
    ].join('\n');

    const result = parseImplementationHandoffs(output, 'source-run-1', TIME_WINDOW);

    assert.equal(result.handoffs.length, 1);
    assert.equal(result.rejections.length, 0);
  });

  test('When the handoff omits readiness then should derive it from the verified issue', () => {
    const handoffWithoutReadiness = handoff();
    delete handoffWithoutReadiness.ready_for_implementation;
    delete handoffWithoutReadiness.dispatch_blocked_by_dry_run;

    const result = parseImplementationHandoffs(
      marked({
        verified_issues: [
          {
            fingerprint: 'fp-valid',
            ready_for_implementation: true,
            dispatch_blocked_by_dry_run: true,
          },
        ],
        implementation_handoffs: [handoffWithoutReadiness],
      }),
      'source-run-1',
      TIME_WINDOW,
    );

    assert.equal(result.handoffs.length, 1);
    assert.equal(result.rejections.length, 0);
    assert.equal(result.handoffs[0].readyForImplementation, true);
    assert.equal(result.handoffs[0].dispatchBlockedByDryRun, true);
  });
});

describe('problemSignatureOf', () => {
  const cases: Array<{
    name: string;
    raw: Record<string, unknown>;
    want: ReturnType<typeof problemSignatureOf>;
  }> = [
    {
      name: 'When the finding carries every field then should read all of them',
      raw: {
        fingerprint: 'checkout-null-payment',
        service: 'api',
        environment: 'production',
        likely_files_or_symbols: ['handlers/checkout.ts'],
      },
      want: {
        fingerprint: 'checkout-null-payment',
        service: 'api',
        environment: 'production',
        likelyFilesOrSymbols: ['handlers/checkout.ts'],
      },
    },
    {
      name: 'When the location is camel cased then should read it too',
      raw: {
        fingerprint: 'checkout-null-payment',
        service: 'api',
        environment: 'production',
        likelyFilesOrSymbols: ['handlers/checkout.ts'],
      },
      want: {
        fingerprint: 'checkout-null-payment',
        service: 'api',
        environment: 'production',
        likelyFilesOrSymbols: ['handlers/checkout.ts'],
      },
    },
    {
      name: 'When the service and the environment are absent then should read them as empty',
      raw: { fingerprint: 'checkout-null-payment' },
      want: {
        fingerprint: 'checkout-null-payment',
        service: '',
        environment: '',
        likelyFilesOrSymbols: [],
      },
    },
    {
      name: 'When there is no fingerprint then should read nothing',
      raw: { service: 'api', environment: 'production' },
      want: undefined,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.deepEqual(problemSignatureOf(c.raw), c.want);
    });
  }
});

describe('hasHandoffShape', () => {
  const cases: Array<{ name: string; value: Record<string, unknown> | undefined; want: boolean }> =
    [
      {
        name: 'When the object carries a handoff array then should succeed',
        value: { implementation_handoffs: [] },
        want: true,
      },
      {
        name: 'When the handoff field is not an array then should return false',
        value: { implementation_handoffs: 'none' },
        want: false,
      },
      {
        name: 'When the object has no handoff field then should return false',
        value: { candidates: [] },
        want: false,
      },
      {
        name: 'When the value is undefined then should return false',
        value: undefined,
        want: false,
      },
    ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(hasHandoffShape(c.value), c.want);
    });
  }
});

describe('normalizeStructuredOutput', () => {
  const scan = {
    telemetry_access: { status: 'ok' },
    candidates: [],
    verified_issues: [],
  };
  const cases: Array<{
    name: string;
    value: Record<string, unknown> | undefined;
    want: Record<string, unknown> | undefined;
  }> = [
    {
      name: 'When a complete scan omits the handoff array then should add it empty',
      value: scan,
      want: { ...scan, implementation_handoffs: [] },
    },
    {
      name: 'When the handoff array is already there then should leave it alone',
      value: { ...scan, implementation_handoffs: [{ fingerprint: 'fp-1' }] },
      want: { ...scan, implementation_handoffs: [{ fingerprint: 'fp-1' }] },
    },
    {
      name: 'When the telemetry block is missing then should leave it alone',
      value: { candidates: [], verified_issues: [] },
      want: { candidates: [], verified_issues: [] },
    },
    {
      name: 'When a list is missing then should leave it alone',
      value: { telemetry_access: { status: 'ok' }, candidates: [] },
      want: { telemetry_access: { status: 'ok' }, candidates: [] },
    },
    {
      name: 'When there is nothing to normalize then should answer nothing',
      value: undefined,
      want: undefined,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.deepEqual(normalizeStructuredOutput(c.value), c.want);
    });
  }
});

function marked(payload: Record<string, unknown>): string {
  return `${HANDOFF_JSON_MARKER} ${JSON.stringify(payload)}`;
}

function handoff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo: 'ExampleOrg/example-service',
    service: 'api',
    environment: 'production',
    fingerprint: 'fp-valid',
    severity: 'high',
    confidence: 0.93,
    user_impact: 'Checkout requests return 500s.',
    evidence: ['5xx rate increased after deploy'],
    representative_sanitized_logs: ['Error: checkout failed request_id=<redacted>'],
    suspected_root_cause: 'Null payment method is not handled.',
    likely_files_or_symbols: ['src/checkout.ts'],
    reproduction_steps: ['Submit checkout without saved payment method.'],
    acceptance_criteria: ['Checkout returns 200 or a validation error instead of 500.'],
    suggested_tests: ['npm test -- checkout'],
    source_log_review_run_id: 'source-run-1',
    ready_for_implementation: true,
    dispatch_blocked_by_dry_run: false,
    ...overrides,
  };
}
