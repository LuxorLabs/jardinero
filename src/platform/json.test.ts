import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  arrayValue,
  isNonBlankString,
  isPlainObject,
  isPositiveSafeInteger,
  objectValue,
  parseJsonObject,
  stringValue,
} from './json.js';

describe('isPlainObject', () => {
  const cases: Array<{ name: string; input: unknown; want: boolean }> = [
    {
      name: 'When the value is an object literal then should succeed',
      input: { a: 1 },
      want: true,
    },
    { name: 'When the value is an empty object then should succeed', input: {}, want: true },
    { name: 'When the value is an array then should return false', input: [1, 2], want: false },
    { name: 'When the value is null then should return false', input: null, want: false },
    { name: 'When the value is a string then should return false', input: 'x', want: false },
    { name: 'When the value is a number then should return false', input: 42, want: false },
    { name: 'When the value is undefined then should return false', input: undefined, want: false },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(isPlainObject(c.input), c.want);
    });
  }
});

describe('objectValue', () => {
  const cases: Array<{
    name: string;
    input: unknown;
    want: Record<string, unknown> | undefined;
  }> = [
    {
      name: 'When the value is an object then should return it',
      input: { a: 1 },
      want: { a: 1 },
    },
    {
      name: 'When the value is an array then should return undefined',
      input: [1],
      want: undefined,
    },
    { name: 'When the value is null then should return undefined', input: null, want: undefined },
    {
      name: 'When the value is a string then should return undefined',
      input: 'x',
      want: undefined,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.deepEqual(objectValue(c.input), c.want);
    });
  }
});

describe('stringValue', () => {
  const cases: Array<{ name: string; input: unknown; want: string | undefined }> = [
    { name: 'When the value is a string then should return it', input: 'hello', want: 'hello' },
    { name: 'When the value is an empty string then should return it', input: '', want: '' },
    { name: 'When the value is a number then should return undefined', input: 42, want: undefined },
    { name: 'When the value is null then should return undefined', input: null, want: undefined },
    {
      name: 'When the value is undefined then should return undefined',
      input: undefined,
      want: undefined,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(stringValue(c.input), c.want);
    });
  }
});

describe('arrayValue', () => {
  const cases: Array<{ name: string; input: unknown; want: unknown[] }> = [
    { name: 'When the value is an array then should return it', input: [1, 2], want: [1, 2] },
    { name: 'When the value is a string then should return an empty array', input: 'x', want: [] },
    { name: 'When the value is null then should return an empty array', input: null, want: [] },
    {
      name: 'When the value is an object then should return an empty array',
      input: { a: 1 },
      want: [],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.deepEqual(arrayValue(c.input), c.want);
    });
  }
});

describe('isPositiveSafeInteger', () => {
  const cases: Array<{ name: string; input: unknown; want: boolean }> = [
    { name: 'When the value is a positive integer then should succeed', input: 42, want: true },
    { name: 'When the value is one then should succeed', input: 1, want: true },
    {
      name: 'When the value is the max safe integer then should succeed',
      input: Number.MAX_SAFE_INTEGER,
      want: true,
    },
    { name: 'When the value is zero then should return false', input: 0, want: false },
    { name: 'When the value is negative then should return false', input: -1, want: false },
    { name: 'When the value is fractional then should return false', input: 1.5, want: false },
    {
      name: 'When the value exceeds the safe integer range then should return false',
      input: Number.MAX_SAFE_INTEGER + 1,
      want: false,
    },
    {
      name: 'When the value is a numeric string then should return false',
      input: '42',
      want: false,
    },
    { name: 'When the value is nan then should return false', input: Number.NaN, want: false },
    { name: 'When the value is undefined then should return false', input: undefined, want: false },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(isPositiveSafeInteger(c.input), c.want);
    });
  }
});

describe('isNonBlankString', () => {
  const cases: Array<{ name: string; input: unknown; want: boolean }> = [
    { name: 'When the value has content then should succeed', input: 'x', want: true },
    {
      name: 'When the value is padded but not blank then should succeed',
      input: '  x  ',
      want: true,
    },
    { name: 'When the value is empty then should return false', input: '', want: false },
    {
      name: 'When the value is only whitespace then should return false',
      input: '   ',
      want: false,
    },
    { name: 'When the value is a number then should return false', input: 42, want: false },
    { name: 'When the value is null then should return false', input: null, want: false },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(isNonBlankString(c.input), c.want);
    });
  }
});

describe('parseJsonObject', () => {
  test('When the json is an object then should return it', () => {
    assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  });

  const rejectCases: Array<{ name: string; input: string }> = [
    { name: 'When the json is an array then should return error', input: '[]' },
    { name: 'When the json is a string then should return error', input: '"str"' },
    { name: 'When the json is null then should return error', input: 'null' },
    { name: 'When the json is a number then should return error', input: '123' },
    { name: 'When the input is not valid json then should return error', input: 'not json' },
  ];

  for (const c of rejectCases) {
    test(c.name, () => {
      assert.throws(() => parseJsonObject(c.input));
    });
  }
});
