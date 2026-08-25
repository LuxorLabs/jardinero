import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  assertExecSucceeded,
  execExitCode,
  execString,
  normalizeRemotePath,
  remoteJoin,
  shellQuote,
} from './tenki-utils.js';

describe('assertExecSucceeded', () => {
  const okCases: Array<{ name: string; result: unknown }> = [
    { name: 'When the exit code is zero then should pass', result: { exitCode: 0 } },
    // A plain string carries no exit code, so there is nothing to fail on.
    { name: 'When the result is a string then should pass', result: 'some output' },
    { name: 'When no exit code is present then should pass', result: { stdout: 'x' } },
  ];

  for (const testCase of okCases) {
    test(testCase.name, () => {
      assert.doesNotThrow(() => assertExecSucceeded(testCase.result as never, 'step'));
    });
  }

  const failureCases: Array<{ name: string; result: Record<string, unknown>; want: RegExp }> = [
    {
      name: 'When the exit code is not zero then should return error with the label and code',
      result: { exitCode: 2 },
      want: /step failed with exit code 2$/,
    },
    {
      name: 'When stderr is present then should append it as the detail',
      result: { exitCode: 1, stderr: 'boom' },
      want: /step failed with exit code 1: boom/,
    },
    {
      // stdout is the fallback detail: some commands report the reason there.
      name: 'When only stdout is present then should append it as the detail',
      result: { exitCode: 1, stdout: 'no such file' },
      want: /exit code 1: no such file/,
    },
    {
      name: 'When the detail is blank then should omit the suffix',
      result: { exitCode: 1, stderr: '   ' },
      want: /exit code 1$/,
    },
  ];

  for (const testCase of failureCases) {
    test(testCase.name, () => {
      assert.throws(() => assertExecSucceeded(testCase.result as never, 'step'), testCase.want);
    });
  }

  test('When the detail is huge then should truncate it', () => {
    assert.throws(
      () => assertExecSucceeded({ exitCode: 1, stderr: 'x'.repeat(900) } as never, 'step'),
      (error: Error) => error.message.length < 600,
    );
  });
});

describe('execString', () => {
  const cases: Array<{ name: string; result: unknown; keys: string[]; want: string }> = [
    {
      name: 'When the key holds a string then should return it',
      result: { stderr: 'e' },
      keys: ['stderr'],
      want: 'e',
    },
    {
      name: 'When the key holds a buffer then should decode it',
      result: { stdout: Buffer.from('from buffer') },
      keys: ['stdout'],
      want: 'from buffer',
    },
    {
      name: 'When the key holds bytes then should decode them',
      result: { stdout: new TextEncoder().encode('from bytes') },
      keys: ['stdout'],
      want: 'from bytes',
    },
    {
      name: 'When the first key is absent then should try the next',
      result: { output: 'second' },
      keys: ['stdout', 'output'],
      want: 'second',
    },
    {
      name: 'When no key matches then should return empty',
      result: { other: 'x' },
      keys: ['stdout'],
      want: '',
    },
    {
      // A bare string result is stdout by convention, so only those keys read it.
      name: 'When the result is a string and stdout is asked then should return it',
      result: 'raw',
      keys: ['stdout'],
      want: 'raw',
    },
    {
      name: 'When the result is a string and stderr is asked then should return empty',
      result: 'raw',
      keys: ['stderr'],
      want: '',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(execString(testCase.result as never, testCase.keys), testCase.want);
    });
  }
});

describe('execExitCode', () => {
  const cases: Array<{ name: string; result: unknown; want?: number }> = [
    { name: 'When exitCode is present then should return it', result: { exitCode: 3 }, want: 3 },
    { name: 'When only code is present then should return it', result: { code: 4 }, want: 4 },
    { name: 'When only status is present then should return it', result: { status: 5 }, want: 5 },
    {
      name: 'When the value is not a number then should return undefined',
      result: { exitCode: '0' },
    },
    { name: 'When the result is a string then should return undefined', result: 'output' },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(execExitCode(testCase.result as never), testCase.want);
    });
  }
});

describe('shellQuote', () => {
  const cases: Array<{ name: string; value: string; want: string }> = [
    {
      name: 'When the value is plain then should wrap it in single quotes',
      value: 'main',
      want: "'main'",
    },
    {
      // The escape is what stops a branch name from closing the quote and running
      // a second command.
      name: 'When the value contains a single quote then should escape it',
      value: "a'b",
      want: "'a'\\''b'",
    },
    { name: 'When the value is empty then should return empty quotes', value: '', want: "''" },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(shellQuote(testCase.value), testCase.want);
    });
  }
});

describe('normalizeRemotePath', () => {
  const cases: Array<{ name: string; value: string; want: string }> = [
    {
      name: 'When the path is clean then should keep it',
      value: '/home/tenki/x',
      want: '/home/tenki/x',
    },
    {
      name: 'When the path has a trailing slash then should drop it',
      value: '/home/tenki/x/',
      want: '/home/tenki/x',
    },
    {
      name: 'When the path has several trailing slashes then should drop them all',
      value: '/a//',
      want: '/a',
    },
    {
      name: 'When the path is surrounded by spaces then should trim it',
      value: '  /a  ',
      want: '/a',
    },
    // Root is the one path whose trailing slash IS the path.
    { name: 'When the path is root then should keep it', value: '/', want: '/' },
    {
      name: 'When the path is empty then should fall back to the workspace',
      value: '   ',
      want: '/home/tenki/workspace',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(normalizeRemotePath(testCase.value), testCase.want);
    });
  }
});

describe('remoteJoin', () => {
  const cases: Array<{ name: string; root: string; parts: string[]; want: string }> = [
    {
      name: 'When parts are given then should join them under the root',
      root: '/w',
      parts: ['a', 'b'],
      want: '/w/a/b',
    },
    {
      name: 'When a part has slashes then should strip them',
      root: '/w',
      parts: ['/a/'],
      want: '/w/a',
    },
    {
      name: 'When a part is blank then should skip it',
      root: '/w',
      parts: ['a', '  ', 'b'],
      want: '/w/a/b',
    },
    {
      name: 'When no parts are given then should return the root',
      root: '/w/',
      parts: [],
      want: '/w',
    },
    // Re-prefixing a root of '/' would double the leading slash.
    {
      name: 'When the root is root then should not double the slash',
      root: '/',
      parts: ['a'],
      want: '/a',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(remoteJoin(testCase.root, ...testCase.parts), testCase.want);
    });
  }
});
