import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { SandboxTask } from './sandbox-pool.js';
import { numberPayload, recordPayload, stringArrayPayload, stringPayload } from './task-payload.js';

describe('stringPayload', () => {
  const cases: Array<{ name: string; value: unknown; want?: string }> = [
    { name: 'When the value is a string then should return it', value: 'main', want: 'main' },
    // A blank string is a missing value, so the caller falls back instead of
    // rendering an empty line into a prompt.
    { name: 'When the value is blank then should return undefined', value: '   ' },
    { name: 'When the value is absent then should return undefined', value: undefined },
    { name: 'When the value is a number then should return undefined', value: 7 },
    { name: 'When the value is null then should return undefined', value: null },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(stringPayload(task({ key: testCase.value }), 'key'), testCase.want);
    });
  }
});

describe('numberPayload', () => {
  const cases: Array<{ name: string; value: unknown; want?: number }> = [
    { name: 'When the value is a number then should return it', value: 7, want: 7 },
    { name: 'When the value is zero then should return it', value: 0, want: 0 },
    { name: 'When the value is nan then should return undefined', value: Number.NaN },
    {
      name: 'When the value is infinite then should return undefined',
      value: Number.POSITIVE_INFINITY,
    },
    { name: 'When the value is a numeric string then should return undefined', value: '7' },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(numberPayload(task({ key: testCase.value }), 'key'), testCase.want);
    });
  }
});

describe('recordPayload', () => {
  const cases: Array<{ name: string; value: unknown; want?: Record<string, unknown> }> = [
    { name: 'When the value is an object then should return it', value: { a: 1 }, want: { a: 1 } },
    // typeof [] is 'object', so the array guard is what keeps a list from being
    // read as a record.
    { name: 'When the value is an array then should return undefined', value: [1, 2] },
    { name: 'When the value is null then should return undefined', value: null },
    { name: 'When the value is a string then should return undefined', value: 'nope' },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.deepEqual(recordPayload(task({ key: testCase.value }), 'key'), testCase.want);
    });
  }
});

describe('stringArrayPayload', () => {
  const cases: Array<{ name: string; record?: Record<string, unknown>; want: string[] }> = [
    {
      name: 'When every entry is a string then should return them',
      record: { key: ['a', 'b'] },
      want: ['a', 'b'],
    },
    {
      // One bad entry drops the whole list: a half-read list would silently lose
      // an item the caller believes it has.
      name: 'When one entry is not a string then should return an empty list',
      record: { key: ['a', 7] },
      want: [],
    },
    {
      name: 'When the value is not an array then should return an empty list',
      record: { key: 'a' },
      want: [],
    },
    { name: 'When the record is absent then should return an empty list', want: [] },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.deepEqual(stringArrayPayload(testCase.record, 'key'), testCase.want);
    });
  }
});

function task(payload: Record<string, unknown>): SandboxTask {
  return { payload } as unknown as SandboxTask;
}
