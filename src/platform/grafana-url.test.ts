import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { toAbsoluteGrafanaTimeRange } from './grafana-url.js';

const WINDOW = { fromAnchorMs: 1_750_000_000_000, toAnchorMs: 1_750_000_600_000 };

describe('toAbsoluteGrafanaTimeRange', () => {
  const rewriteCases = [
    {
      name: 'When panes range is relative then should rewrite to absolute epoch ms',
      url: exploreUrl({ from: 'now-90m', to: 'now' }),
      want: { from: '1749994600000', to: '1750000600000' },
    },
    {
      name: 'When panes from is absolute and to is now then should rewrite only to',
      url: exploreUrl({ from: '1749990000000', to: 'now' }),
      want: { from: '1749990000000', to: '1750000600000' },
    },
    {
      name: 'When panes range uses day unit then should rewrite to absolute epoch ms',
      url: exploreUrl({ from: 'now-7d', to: 'now' }),
      want: { from: '1749395200000', to: '1750000600000' },
    },
    {
      name: 'When panes range uses second unit then should rewrite to absolute epoch ms',
      url: exploreUrl({ from: 'now-30s', to: 'now' }),
      want: { from: '1749999970000', to: '1750000600000' },
    },
    {
      name: 'When panes range uses week unit then should rewrite to absolute epoch ms',
      url: exploreUrl({ from: 'now-1w', to: 'now' }),
      want: { from: '1749395200000', to: '1750000600000' },
    },
    {
      name: 'When panes range uses month unit then should rewrite to absolute epoch ms',
      url: exploreUrl({ from: 'now-1M', to: 'now' }),
      want: { from: '1747408000000', to: '1750000600000' },
    },
    {
      name: 'When panes range uses year unit then should rewrite to absolute epoch ms',
      url: exploreUrl({ from: 'now-1y', to: 'now' }),
      want: { from: '1718464000000', to: '1750000600000' },
    },
  ];

  for (const c of rewriteCases) {
    test(c.name, () => {
      assert.deepEqual(paneRangeOf(toAbsoluteGrafanaTimeRange(c.url, WINDOW)), c.want);
    });
  }

  test('When top level from to are relative then should rewrite to absolute epoch ms', () => {
    const result = toAbsoluteGrafanaTimeRange(
      'https://grafana.example.com/d/abc/service?from=now-1h&to=now&orgId=1',
      WINDOW,
    );
    const params = new URL(result).searchParams;
    assert.equal(params.get('from'), '1749996400000');
    assert.equal(params.get('to'), '1750000600000');
    assert.equal(params.get('orgId'), '1');
  });

  const unchangedCases = [
    {
      name: 'When panes range is already absolute then should return url unchanged',
      url: exploreUrl({ from: '1749990000000', to: '1749993600000' }),
    },
    {
      name: 'When relative expression is rounded then should return url unchanged',
      url: exploreUrl({ from: 'now-1d/d', to: 'now' }),
    },
    {
      name: 'When url is not parseable then should return input unchanged',
      url: 'not a url at all',
    },
    {
      name: 'When panes json is malformed then should return url unchanged',
      url: 'https://grafana.example.com/explore?panes=%7Bnot-json&orgId=1',
    },
    {
      name: 'When url has no time range then should return url unchanged',
      url: 'https://grafana.example.com/explore?schemaVersion=1&orgId=1',
    },
    {
      name: 'When only from param is present then should return url unchanged',
      url: 'https://grafana.example.com/d/abc/service?from=now-1h&orgId=1',
    },
    {
      name: 'When panes json parses to an array then should return url unchanged',
      url: 'https://grafana.example.com/explore?panes=%5B%5D&orgId=1',
    },
    {
      name: 'When panes json parses to a number then should return url unchanged',
      url: 'https://grafana.example.com/explore?panes=42&orgId=1',
    },
    {
      name: 'When panes pane value is not an object then should return url unchanged',
      url: `https://grafana.example.com/explore?panes=${encodeURIComponent(JSON.stringify({ a: 'nope' }))}&orgId=1`,
    },
    {
      name: 'When panes pane has no range then should return url unchanged',
      url: `https://grafana.example.com/explore?panes=${encodeURIComponent(JSON.stringify({ a: { datasource: 'x' } }))}&orgId=1`,
    },
    {
      name: 'When panes range has non string from and to then should return url unchanged',
      url: `https://grafana.example.com/explore?panes=${encodeURIComponent(JSON.stringify({ a: { range: { from: 123, to: 456 } } }))}&orgId=1`,
    },
    {
      name: 'When offset amount is absurdly large then should return url unchanged',
      url: exploreUrl({ from: 'now-999999999999999999999s', to: 'now' }),
    },
    {
      name: 'When offset result is before epoch then should return url unchanged',
      url: exploreUrl({ from: 'now-100y', to: 'now' }),
    },
  ];

  for (const c of unchangedCases) {
    test(c.name, () => {
      assert.equal(toAbsoluteGrafanaTimeRange(c.url, WINDOW), c.url);
    });
  }

  test('When only one pane is convertible then should rewrite that pane only', () => {
    const panes = {
      a: { range: { from: 'now-90m', to: 'now' } },
      b: { range: { from: 'now-1d/d', to: 'now' } },
    };
    const url = `https://grafana.example.com/explore?panes=${encodeURIComponent(JSON.stringify(panes))}&orgId=1`;
    const rewritten = new URL(toAbsoluteGrafanaTimeRange(url, WINDOW)).searchParams.get('panes');
    assert.ok(rewritten);
    const parsed = JSON.parse(rewritten);
    assert.deepEqual(parsed.a.range, { from: '1749994600000', to: '1750000600000' });
    assert.deepEqual(parsed.b.range, { from: 'now-1d/d', to: 'now' });
  });
});

// Explore URL shaped like the ones Grafana MCP emits in production handoffs.
function exploreUrl(range: Record<string, string>): string {
  const panes = { ljh: { datasource: 'ds-uid', queries: [{ refId: 'A' }], range } };
  return `https://grafana.example.com/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}&orgId=1`;
}

function paneRangeOf(url: string): Record<string, string> {
  const panes = new URL(url).searchParams.get('panes');
  assert.ok(panes);
  return JSON.parse(panes).ljh.range;
}
