import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { SandboxExecResult } from '../../types.js';
import {
  assertExecSucceeded,
  buildGitCloneCommand,
  concatBytes,
  execStderr,
  execStdout,
  normalizeRemotePath,
  numberOption,
  remoteJoin,
  renderShellEnvironment,
  shellQuote,
  streamToBytes,
  stringOption,
  stringRecord,
  throwIfAborted,
  workerEnvironment,
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

describe('workerEnvironment', () => {
  const cases: Array<{ name: string; env: Record<string, string>; want: Record<string, string> }> =
    [
      {
        name: 'When the run carries variables then should keep them under the worker identity',
        env: { GITHUB_TOKEN: 'gh' },
        want: {
          GITHUB_TOKEN: 'gh',
          HOME: '/home/tenki',
          USER: 'tenki',
          LOGNAME: 'tenki',
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        },
      },
      {
        // The worker identity is not the caller's to choose.
        name: 'When the run tries to set HOME then should override it',
        env: { HOME: '/root' },
        want: {
          HOME: '/home/tenki',
          USER: 'tenki',
          LOGNAME: 'tenki',
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        },
      },
    ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.deepEqual(workerEnvironment(testCase.env), testCase.want);
    });
  }
});

describe('renderShellEnvironment', () => {
  const cases: Array<{ name: string; env: Record<string, string>; want: string }> = [
    {
      name: 'When a value contains shell syntax then should quote it',
      env: { SAFE_NAME: "one'two" },
      want: "export SAFE_NAME='one'\\''two'\n",
    },
    {
      // An unexportable name would render a line the shell refuses to source.
      name: 'When a name is not a valid identifier then should omit it',
      env: { 'NOT-SAFE': 'value' },
      want: '\n',
    },
    { name: 'When the environment is empty then should render nothing', env: {}, want: '\n' },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(renderShellEnvironment(testCase.env), testCase.want);
    });
  }
});

describe('buildGitCloneCommand', () => {
  test('When a clone is built then should pass the token through a helper, never the URL', () => {
    const command = buildGitCloneCommand('https://github.com/example/repo.git', '/w/repo');

    assert.match(command, /credential\.helper/);
    assert.match(command, /password=\$GITHUB_TOKEN/);
    assert.ok(command.includes("'https://github.com/example/repo.git'"), command);
    assert.ok(command.includes("'/w/repo'"), command);
  });
});

describe('throwIfAborted', () => {
  const cases: Array<{ name: string; aborted: boolean; wantError?: RegExp }> = [
    { name: 'When the signal is live then should succeed', aborted: false },
    {
      name: 'When the signal is aborted then should return error',
      aborted: true,
      wantError: /Run aborted/,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const controller = new AbortController();
      if (testCase.aborted) controller.abort();

      const act = () => throwIfAborted(controller.signal);
      if (testCase.wantError) assert.throws(act, testCase.wantError);
      else assert.doesNotThrow(act);
    });
  }
});

describe('streamToBytes', () => {
  const cases: Array<{ name: string; chunks: string[]; want: string }> = [
    { name: 'When the stream has one chunk then should return it', chunks: ['only'], want: 'only' },
    {
      name: 'When the stream has several chunks then should join them in order',
      chunks: ['a', 'b', 'c'],
      want: 'abc',
    },
    { name: 'When the stream is empty then should return no bytes', chunks: [], want: '' },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of testCase.chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });

      assert.equal(new TextDecoder().decode(await streamToBytes(stream)), testCase.want);
    });
  }
});

describe('concatBytes', () => {
  const cases: Array<{ name: string; chunks: string[]; want: string }> = [
    {
      name: 'When chunks are given then should join them in order',
      chunks: ['a', 'bc'],
      want: 'abc',
    },
    { name: 'When no chunks are given then should return no bytes', chunks: [], want: '' },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const encoder = new TextEncoder();
      const joined = concatBytes(testCase.chunks.map((chunk) => encoder.encode(chunk)));

      assert.equal(new TextDecoder().decode(joined), testCase.want);
    });
  }
});

describe('stringRecord', () => {
  const cases: Array<{ name: string; value: unknown; want: Record<string, string> }> = [
    {
      name: 'When every value is a string then should keep them all',
      value: { a: 'x' },
      want: { a: 'x' },
    },
    {
      name: 'When a value is not a string then should drop that entry',
      value: { a: 'x', b: 2 },
      want: { a: 'x' },
    },
    { name: 'When the value is an array then should return empty', value: ['a'], want: {} },
    { name: 'When the value is null then should return empty', value: null, want: {} },
    { name: 'When the value is not an object then should return empty', value: 'a', want: {} },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.deepEqual(stringRecord(testCase.value), testCase.want);
    });
  }
});

describe('stringOption', () => {
  const cases: Array<{ name: string; value: unknown; want?: string }> = [
    { name: 'When the value is a string then should trim it', value: '  x  ', want: 'x' },
    { name: 'When the value is blank then should return undefined', value: '   ' },
    { name: 'When the value is not a string then should return undefined', value: 7 },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(stringOption(testCase.value), testCase.want);
    });
  }
});

describe('numberOption', () => {
  const cases: Array<{ name: string; value: unknown; want?: number }> = [
    { name: 'When the value is a number then should return it', value: 4, want: 4 },
    { name: 'When the value is not finite then should return undefined', value: Number.NaN },
    { name: 'When the value is not a number then should return undefined', value: '4' },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(numberOption(testCase.value), testCase.want);
    });
  }
});

function execResult(exitCode: number, stdout = '', stderr = ''): SandboxExecResult {
  const encoder = new TextEncoder();
  return { exitCode, stdout: encoder.encode(stdout), stderr: encoder.encode(stderr) };
}
