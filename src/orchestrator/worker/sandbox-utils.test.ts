import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { SandboxExecResult } from '../../types.js';
import {
  assertExecSucceeded,
  execStderr,
  execStdout,
  normalizeRemotePath,
  remoteJoin,
  shellQuote,
} from './sandbox-utils.js';

describe('assertExecSucceeded', () => {
  const cases: Array<{ name: string; result: SandboxExecResult; want?: RegExp }> = [
    { name: 'When the exit code is zero then should succeed', result: execResult(0) },
    {
      name: 'When the exit code is not zero then should return error with the label and code',
      result: execResult(2),
      want: /step failed with exit code 2$/,
    },
    {
      name: 'When stderr is present then should append it as the detail',
      result: execResult(1, '', 'boom'),
      want: /step failed with exit code 1: boom$/,
    },
    {
      // stdout is the fallback detail: some commands report the reason there.
      name: 'When only stdout is present then should append it as the detail',
      result: execResult(1, 'no such file'),
      want: /step failed with exit code 1: no such file$/,
    },
    {
      name: 'When the detail is blank then should omit the suffix',
      result: execResult(1, '', '   '),
      want: /step failed with exit code 1$/,
    },
    {
      name: 'When the detail is longer than the cap then should truncate it',
      result: execResult(1, '', 'x'.repeat(900)),
      want: /step failed with exit code 1: x{500}$/,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      if (!testCase.want) {
        assert.doesNotThrow(() => assertExecSucceeded(testCase.result, 'step'));
        return;
      }
      assert.throws(() => assertExecSucceeded(testCase.result, 'step'), testCase.want);
    });
  }
});

describe('execStdout', () => {
  const cases: Array<{ name: string; result: SandboxExecResult; want: string }> = [
    {
      name: 'When stdout carries bytes then should decode them',
      result: execResult(0, 'from bytes'),
      want: 'from bytes',
    },
    { name: 'When stdout is empty then should return empty', result: execResult(0), want: '' },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(execStdout(testCase.result), testCase.want);
    });
  }
});

describe('execStderr', () => {
  const cases: Array<{ name: string; result: SandboxExecResult; want: string }> = [
    {
      name: 'When stderr carries bytes then should decode them',
      result: execResult(1, '', 'boom'),
      want: 'boom',
    },
    { name: 'When stderr is empty then should return empty', result: execResult(0), want: '' },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(execStderr(testCase.result), testCase.want);
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

function execResult(exitCode: number, stdout = '', stderr = ''): SandboxExecResult {
  const encoder = new TextEncoder();
  return { exitCode, stdout: encoder.encode(stdout), stderr: encoder.encode(stderr) };
}
