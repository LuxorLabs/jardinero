import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { dayKey, iso, minutes, nowMs } from './time.js';

const NOON = Date.UTC(2026, 6, 29, 12, 0, 0, 0);

describe('nowMs', () => {
  test('When called then should return the wall clock in milliseconds', () => {
    const before = Date.now();
    const value = nowMs();

    assert.ok(value >= before && value <= Date.now());
  });
});

describe('dayKey', () => {
  const cases: Array<{ name: string; at?: number; want: string }> = [
    {
      name: 'When a timestamp is given then should return its utc date',
      at: NOON,
      want: '2026-07-29',
    },
    {
      // The key is the audit log's file name, so it must roll at UTC midnight and
      // not at the host's local midnight.
      name: 'When the timestamp is the last utc millisecond of a day then should keep that day',
      at: Date.UTC(2026, 6, 29, 23, 59, 59, 999),
      want: '2026-07-29',
    },
    {
      name: 'When the timestamp is the first utc millisecond of a day then should roll over',
      at: Date.UTC(2026, 6, 30, 0, 0, 0, 0),
      want: '2026-07-30',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(dayKey(testCase.at), testCase.want);
    });
  }

  test('When no timestamp is given then should use the current day', () => {
    assert.equal(dayKey(), new Date().toISOString().slice(0, 10));
  });
});

describe('minutes', () => {
  const cases: Array<{ name: string; value: number; want: number }> = [
    { name: 'When the value is one then should return sixty thousand', value: 1, want: 60_000 },
    { name: 'When the value is zero then should return zero', value: 0, want: 0 },
    { name: 'When the value is fractional then should scale it', value: 0.5, want: 30_000 },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(minutes(testCase.value), testCase.want);
    });
  }
});

describe('iso', () => {
  test('When a timestamp is given then should render it as utc iso', () => {
    assert.equal(iso(NOON), '2026-07-29T12:00:00.000Z');
  });
});
