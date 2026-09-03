import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DaytonaProcessExecutionTimeoutError, type Sandbox } from '@daytona/sdk';

import { loadConfig, type AppConfig } from '../../config.js';
import type { SandboxRun } from '../../store/types.js';
import type { SandboxRunContext } from '../sandbox-pool.js';
import {
  DaytonaSandboxProvider,
  DaytonaWorkerRunner,
  daytonaSandboxCreateParams,
  daytonaSandboxName,
  renderShellEnvironment,
} from './daytona-worker.js';

describe('DaytonaWorkerRunner', () => {
  test('When it is constructed without credentials then should defer authentication until a run', () => {
    assert.doesNotThrow(() => new DaytonaWorkerRunner(daytonaConfig(), {}));
  });

  test('When a run finishes then should drive it on a Daytona sandbox and delete it', async () => {
    const fake = fakeSandbox({ streamedStdout: '{"type":"turn.completed"}\n' });
    const config = daytonaConfig();
    // api_key keeps Codex auth off the host's ~/.codex, which a unit test has no
    // business reading.
    config.worker.codexAuthMode = 'api_key';
    const env: NodeJS.ProcessEnv = {
      DAYTONA_API_KEY: 'key',
      [config.worker.githubTokenEnv]: 'gh-token',
      [config.worker.codexApiKeyEnv]: 'codex-key',
    };
    const events: string[] = [];
    const runner = new DaytonaWorkerRunner(config, env, {
      createClient: () => fakeClient(fake),
    });

    const result = await runner.run(fakeContext(events));

    assert.equal(result.status, 'succeeded');
    assert.equal(result.sandboxSessionId, 'sandbox-1');
    assert.ok(events.includes('sandbox.ready'), events.join(','));
    assert.equal(fake.deleteCalls, 1);
  });
});

describe('DaytonaSandboxProvider.create', () => {
  const cases: Array<{
    name: string;
    options: Record<string, unknown>;
    sandbox?: FakeSandboxOptions;
    aborted?: boolean;
    abortAfterCreate?: boolean;
    wantCreateCalls: number;
    wantDeletes: number;
    wantError?: RegExp;
  }> = [
    {
      name: 'When the signal is already aborted then should create no sandbox',
      options: {},
      aborted: true,
      wantCreateCalls: 0,
      wantDeletes: 0,
      wantError: /Run aborted/,
    },
    {
      name: 'When creation succeeds then should prepare the worker user and answer the session',
      options: { name: 'agent-fix-run', image: 'snapshot-1', env: { GITHUB_TOKEN: 'tok' } },
      wantCreateCalls: 1,
      wantDeletes: 0,
    },
    {
      name: 'When worker preparation fails then should delete the sandbox',
      options: { name: 'agent-fix-run', image: 'snapshot-1' },
      sandbox: { rootExecResponse: { exitCode: 1, result: 'useradd: not found' } },
      wantCreateCalls: 1,
      wantDeletes: 1,
      wantError: /prepare Daytona worker user failed/,
    },
    {
      name: 'When the signal aborts during creation then should delete the sandbox',
      options: {},
      abortAfterCreate: true,
      wantCreateCalls: 1,
      wantDeletes: 1,
      wantError: /Run aborted/,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const fake = fakeSandbox(testCase.sandbox);
      let createCalls = 0;
      const controller = new AbortController();
      const provider = providerWith(fake, () => {
        createCalls += 1;
        if (testCase.abortAfterCreate) controller.abort();
      });
      if (testCase.aborted) controller.abort();

      const act = () => provider.create(testCase.options, controller.signal);
      if (testCase.wantError) {
        await assert.rejects(act, testCase.wantError);
      } else {
        const session = await act();
        assert.equal(session.id, 'sandbox-1');
        assert.ok(
          fake.execCommands.some(
            (command) => command.includes('useradd') && command.includes('chmod 755'),
          ),
          fake.execCommands.join(','),
        );
        assert.ok(fake.files.has('/home/tenki/.jardinero-env.sh'));
      }

      assert.equal(createCalls, testCase.wantCreateCalls);
      assert.equal(fake.deleteCalls, testCase.wantDeletes);
    });
  }

  test('When the configured credential is absent then should reject before calling the API', async () => {
    const provider = new DaytonaSandboxProvider(daytonaConfig(), {});

    await assert.rejects(
      () => provider.create({}, new AbortController().signal),
      /Missing DAYTONA_API_KEY/,
    );
  });
});

describe('DaytonaSandboxProvider.apiTarget', () => {
  const cases = [
    {
      name: 'When no override exists then should name the public API',
      value: undefined,
      want: 'app.daytona.io',
    },
    {
      name: 'When an override is a URL then should name its host',
      value: 'https://api.example.test/api',
      want: 'api.example.test',
    },
    {
      name: 'When an override is invalid then should use a generic name',
      value: 'not a URL',
      want: 'Daytona API',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const env = testCase.value === undefined ? {} : { DAYTONA_API_URL: testCase.value };

      const provider = new DaytonaSandboxProvider(daytonaConfig(), env);

      assert.equal(provider.apiTarget, testCase.want);
    });
  }
});

describe('DaytonaSandboxProvider.waitReady', () => {
  const cases = [
    { name: 'When the signal is live then should return', aborted: false, wantError: undefined },
    {
      name: 'When the signal is aborted then should return error',
      aborted: true,
      wantError: /Run aborted/,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const provider = providerWith(fakeSandbox());
      const controller = new AbortController();
      if (testCase.aborted) controller.abort();

      const act = () => provider.waitReady({} as never, controller.signal);
      if (testCase.wantError) await assert.rejects(act, testCase.wantError);
      else await assert.doesNotReject(act);
    });
  }
});

describe('DaytonaSandboxProvider.terminate', () => {
  test('When the session owns a sandbox then should delete it', async () => {
    const fake = fakeSandbox();
    const provider = providerWith(fake);
    const session = await provider.create({}, new AbortController().signal);

    await provider.terminate(session);

    assert.equal(fake.deleteCalls, 1);
  });
});

describe('DaytonaSession.exec', () => {
  const cases: Array<{
    name: string;
    sandbox?: FakeSandboxOptions;
    command: string;
    args?: string[];
    stream: boolean;
    abortWhileRunning?: boolean;
    wantCommandContains?: string[];
    wantExitCode?: number;
    wantStdout?: string;
    wantStderr?: RegExp;
    wantChunks?: Array<{ text: string; stderr: boolean; final: boolean }>;
    wantDeletedSessions: number;
    wantError?: RegExp;
  }> = [
    {
      name: 'When no output sink is given then should run it as a one-shot exec under the worker user',
      command: 'printf',
      args: ['hello world'],
      stream: false,
      // The worker wrapper shell-quotes the inner command, so the recorded
      // string carries escaped quotes; match the stable fragments instead.
      wantCommandContains: [
        'sudo -n -u tenki sh -c ',
        '.jardinero-env.sh',
        'printf',
        'hello world',
      ],
      wantExitCode: 0,
      wantStdout: '',
      wantDeletedSessions: 0,
    },
    {
      // The SDK reports a command its timeout killed as a thrown error, so the
      // timeout has to be named or it reads as the whole run's failure.
      name: 'When a one-shot exec hits the provider timeout then should say so on stderr',
      sandbox: { execError: new DaytonaProcessExecutionTimeoutError('deadline') },
      command: 'sleep',
      stream: false,
      wantExitCode: 1,
      wantStdout: '',
      wantStderr: /timed out after 300s/,
      wantDeletedSessions: 0,
    },
    {
      name: 'When a one-shot exec fails on infrastructure then should return error',
      sandbox: { execError: new Error('daemon unreachable') },
      command: 'true',
      stream: false,
      wantError: /daemon unreachable/,
      wantDeletedSessions: 0,
    },
    {
      name: 'When an output sink is given then should stream stdout and stderr separately',
      sandbox: { streamedStdout: '{"type":"thread.started"}\n', streamedStderr: 'note\n' },
      command: 'sh',
      args: ['-lc', 'codex exec --json'],
      stream: true,
      wantExitCode: 0,
      wantStdout: '{"type":"thread.started"}\n',
      wantStderr: /note/,
      wantChunks: [
        { text: '{"type":"thread.started"}\n', stderr: false, final: false },
        { text: 'note\n', stderr: true, final: false },
        { text: '', stderr: false, final: true },
      ],
      wantDeletedSessions: 1,
    },
    {
      name: 'When a session command exits unsuccessfully then should return its exit code',
      sandbox: { streamedStdout: 'failed\n', sessionExitCode: 23 },
      command: 'failing-command',
      stream: true,
      wantExitCode: 23,
      wantStdout: 'failed\n',
      wantDeletedSessions: 1,
    },
    {
      name: 'When the command completes with no exit code then should read it as a failure',
      sandbox: { sessionExitCode: null },
      command: 'long-command',
      stream: true,
      wantExitCode: 1,
      wantStdout: '',
      wantDeletedSessions: 1,
    },
    {
      name: 'When the session answers no command id then should return error and close the session',
      sandbox: { missingCommandId: true },
      command: 'long-command',
      stream: true,
      wantError: /no command id/,
      wantDeletedSessions: 1,
    },
    {
      name: 'When the log stream fails then should return error and close the session',
      sandbox: { logsError: new Error('socket lost') },
      command: 'long-command',
      stream: true,
      wantError: /socket lost/,
      wantDeletedSessions: 1,
    },
    {
      name: 'When the run aborts while streaming then should kill the session',
      sandbox: { holdLogsOpen: true },
      command: 'long-command',
      stream: true,
      abortWhileRunning: true,
      wantError: /Run aborted/,
      wantDeletedSessions: 2,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const fake = fakeSandbox(testCase.sandbox);
      const controller = new AbortController();
      const session = await providerWith(fake).create({}, controller.signal);
      fake.execCommands.length = 0;
      const chunks: Array<{ text: string; stderr: boolean; final: boolean }> = [];
      assert.ok(session.exec);

      const running = session.exec(testCase.command, {
        ...(testCase.args ? { args: testCase.args } : {}),
        ...(testCase.stream
          ? {
              onOutput: (chunk) => {
                chunks.push({
                  text: new TextDecoder().decode(chunk.data),
                  stderr: chunk.isStderr,
                  final: chunk.isFinal,
                });
              },
            }
          : {}),
      });
      if (testCase.abortWhileRunning) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.abort();
      }

      if (testCase.wantError) {
        await assert.rejects(running, testCase.wantError);
      } else {
        const result = await running;
        assert.equal(result.exitCode, testCase.wantExitCode);
        assert.equal(new TextDecoder().decode(result.stdout), testCase.wantStdout);
        if (testCase.wantStderr) {
          assert.match(new TextDecoder().decode(result.stderr), testCase.wantStderr);
        }
      }

      for (const wanted of testCase.wantCommandContains ?? []) {
        assert.ok(
          [...fake.execCommands, ...fake.sessionCommands].some((command) =>
            command.includes(wanted),
          ),
          `${wanted} not in ${[...fake.execCommands, ...fake.sessionCommands].join(',')}`,
        );
      }
      if (testCase.stream) {
        assert.equal(fake.createdSessions.length, 1);
      }
      if (testCase.wantChunks) assert.deepEqual(chunks, testCase.wantChunks);
      assert.equal(fake.deletedSessions.length, testCase.wantDeletedSessions);
    });
  }
});

describe('DaytonaSession file access', () => {
  test('When files are written then should leave every one owned by the worker user', async () => {
    const fake = fakeSandbox();
    const session = await providerWith(fake).create({}, new AbortController().signal);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed'));
        controller.close();
      },
    });

    await session.writeFile('/tmp/direct', 'direct');
    await session.fs.writeStream('/tmp/stream', source, { mode: 0o600 });
    await session.fs.mkdir('/tmp/directory');

    assert.ok(session.readFile);
    const direct = await session.readFile('/tmp/direct');
    assert.equal(typeof direct === 'string' ? direct : new TextDecoder().decode(direct), 'direct');
    assert.equal(await new Response(await session.fs.readStream('/tmp/stream')).text(), 'streamed');
    assert.ok(
      fake.execCommands.some(
        (command) => command.includes('mkdir -p') && command.includes('/tmp/directory'),
      ),
      fake.execCommands.join(','),
    );
    // The root wrapper shell-quotes the chown command, so the recorded string
    // carries escaped quotes; find each grant by its stable fragments.
    const chownOf = (path: string) =>
      fake.execCommands.find(
        (command) => command.includes('chown tenki:tenki') && command.includes(path),
      );
    assert.match(chownOf('/tmp/direct') ?? '', /chmod 644/);
    assert.match(chownOf('/tmp/stream') ?? '', /chmod 600/);
    assert.ok(chownOf('/tmp/directory'));
  });
});

describe('DaytonaSession.git.clone', () => {
  test('When a clone is requested then should pass the token through a helper, never the command', async () => {
    const fake = fakeSandbox();
    const session = await providerWith(fake).create(
      { env: { GITHUB_TOKEN: 'top-secret' } },
      new AbortController().signal,
    );

    assert.ok(session.git);
    await session.git.clone('https://github.com/example/repo.git', {
      directory: '/home/tenki/workspace/repo',
    });

    const launch = fake.sessionCommands[0];
    assert.ok(launch);
    assert.match(launch, /credential\.helper/);
    assert.doesNotMatch(launch, /top-secret/);
    const envFile = fake.files.get('/home/tenki/.jardinero-env.sh');
    assert.ok(envFile);
    assert.match(new TextDecoder().decode(envFile), /GITHUB_TOKEN='top-secret'/);
  });
});

describe('daytonaSandboxCreateParams', () => {
  const cases: Array<{
    name: string;
    input: Record<string, unknown>;
    check(params: ReturnType<typeof daytonaSandboxCreateParams>): void;
  }> = [
    {
      name: 'When Tenki-shaped options are complete then should map them to a Daytona sandbox',
      input: {
        name: 'Agent Fix 123',
        image: 'snapshot-1',
        maxDurationMs: 60_500,
        metadata: { run_id: 'run-1' },
      },
      check: (params) => {
        assert.equal(params.name, 'agent-fix-123');
        assert.equal(params.snapshot, 'snapshot-1');
        assert.equal(params.ttlMinutes, 7);
        assert.deepEqual(params.labels, { run_id: 'run-1' });
      },
    },
    {
      name: 'When optional values are absent then should use bounded disposable defaults',
      input: {},
      check: (params) => {
        assert.match(params.name ?? '', /^jardinero-[a-f0-9]{8}$/);
        assert.equal(params.snapshot, undefined);
        assert.equal(params.ttlMinutes, 35);
      },
    },
    {
      name: 'When metadata exceeds label limits then should truncate it',
      input: { metadata: { ['k'.repeat(80)]: 'v'.repeat(80) } },
      check: (params) => {
        const [entry] = Object.entries(params.labels ?? {});
        assert.equal(entry?.[0].length, 63);
        assert.equal(entry?.[1].length, 63);
      },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const params = daytonaSandboxCreateParams(testCase.input);

      testCase.check(params);
      assert.equal(params.ephemeral, true);
      assert.equal(params.autoStopInterval, 0);
    });
  }
});

describe('daytonaSandboxName', () => {
  const cases = [
    {
      name: 'When the value needs normalization then should return a valid name',
      value: ' Agent PR_Maintain 1 ',
      want: 'agent-pr-maintain-1',
    },
    {
      name: 'When the value is too long then should cap it',
      value: 'a'.repeat(80),
      want: 'a'.repeat(63),
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(daytonaSandboxName(testCase.value), testCase.want);
    });
  }

  test('When the value has no usable characters then should mint a name', () => {
    assert.match(daytonaSandboxName('___'), /^jardinero-[a-f0-9]{8}$/);
  });
});

describe('renderShellEnvironment', () => {
  test('When values contain shell syntax and a name is invalid then should quote values and omit the name', () => {
    assert.equal(
      renderShellEnvironment({ SAFE_NAME: "one'two", 'NOT-SAFE': 'value' }),
      "export SAFE_NAME='one'\\''two'\n",
    );
  });
});

interface FakeSandbox extends Sandbox {
  execCommands: string[];
  sessionCommands: string[];
  createdSessions: string[];
  deletedSessions: string[];
  files: Map<string, Uint8Array>;
  deleteCalls: number;
}

function providerWith(fake: FakeSandbox, onCreate: () => void = () => undefined) {
  return new DaytonaSandboxProvider(
    daytonaConfig(),
    { DAYTONA_API_KEY: 'key' },
    {
      createClient: () => ({
        create: async () => {
          onCreate();
          return fake;
        },
      }),
    },
  );
}

interface FakeSandboxOptions {
  // Only the session's worker execs honor these; the root-level prepare and
  // chown commands have to keep succeeding whatever the case scripts.
  execResponse?: { exitCode: number; result: string };
  execError?: Error;
  rootExecResponse?: { exitCode: number; result: string };
  streamedStdout?: string;
  streamedStderr?: string;
  // null is how a command that never reported an exit code reads back.
  sessionExitCode?: number | null;
  missingCommandId?: boolean;
  logsError?: Error;
  holdLogsOpen?: boolean;
}

function fakeSandbox(options: FakeSandboxOptions = {}): FakeSandbox {
  const files = new Map<string, Uint8Array>();
  const execCommands: string[] = [];
  const sessionCommands: string[] = [];
  const createdSessions: string[] = [];
  const deletedSessions: string[] = [];
  let deleteCalls = 0;
  const sandbox = {
    id: 'sandbox-1',
    execCommands,
    sessionCommands,
    createdSessions,
    deletedSessions,
    files,
    get deleteCalls() {
      return deleteCalls;
    },
    delete: async () => {
      deleteCalls += 1;
    },
    fs: {
      uploadFile: async (file: Buffer, remotePath: string) => {
        files.set(remotePath, new Uint8Array(file));
      },
      downloadFile: async (remotePath: string) => {
        const value = files.get(remotePath);
        if (!value) throw new Error(`no such file: ${remotePath}`);
        return Buffer.from(value);
      },
    },
    process: {
      executeCommand: async (command: string) => {
        execCommands.push(command);
        const isWorkerExec = command.startsWith('sudo -n -u tenki ');
        if (isWorkerExec && options.execError) throw options.execError;
        applyRootMove(command, files);
        const response = isWorkerExec ? options.execResponse : options.rootExecResponse;
        return {
          exitCode: response?.exitCode ?? 0,
          result: response?.result ?? '',
          artifacts: { stdout: response?.result ?? '' },
        };
      },
      createSession: async (sessionId: string) => {
        createdSessions.push(sessionId);
      },
      executeSessionCommand: async (_sessionId: string, req: { command: string }) => {
        sessionCommands.push(req.command);
        return { cmdId: options.missingCommandId ? undefined : 'cmd-1' };
      },
      getSessionCommandLogs: async (
        _sessionId: string,
        _commandId: string,
        onStdout: (chunk: string) => void,
        onStderr: (chunk: string) => void,
      ) => {
        if (options.holdLogsOpen) return new Promise<void>(() => undefined);
        if (options.logsError) throw options.logsError;
        if (options.streamedStdout) onStdout(options.streamedStdout);
        if (options.streamedStderr) onStderr(options.streamedStderr);
      },
      getSessionCommand: async () => ({
        exitCode: options.sessionExitCode === undefined ? 0 : options.sessionExitCode,
      }),
      deleteSession: async (sessionId: string) => {
        deletedSessions.push(sessionId);
      },
    },
  } as unknown as FakeSandbox;
  return sandbox;
}

// Mirrors what the root wrapper's `mv staging target` would do to the sandbox
// filesystem, so readbacks see installed files at their final path.
function applyRootMove(command: string, files: Map<string, Uint8Array>): void {
  const payload = command.match(/then sh -c '([\s\S]*?)'; else sudo -n sh -c /)?.[1];
  if (!payload) return;
  const unquoted = payload.replaceAll("'\\''", "'");
  const move = unquoted.match(/^mv '([^']+)' '([^']+)'/);
  if (!move) return;
  const content = files.get(move[1]!);
  if (content === undefined) return;
  files.delete(move[1]!);
  files.set(move[2]!, content);
}

function daytonaConfig(): AppConfig {
  const config = loadConfig();
  config.worker.runner = 'daytona';
  config.worker.default.image = 'snapshot-1';
  return config;
}

function fakeClient(fake: FakeSandbox) {
  return {
    create: async () => fake,
  };
}

function fakeContext(events: string[]): SandboxRunContext {
  const sandboxRun: SandboxRun = {
    id: 'run-daytona-test',
    agentName: 'Agent',
    runState: 'running',
    workflowType: 'pr_maintainer',
    workflowInstanceId: 'instance-1',
    sandboxSessionId: null,
    costUsd: null,
    errorMessage: null,
    startedAt: 0,
    endedAt: null,
  };
  return {
    sandboxRun,
    task: { workflow: 'pr_maintain', payload: {}, promptOverrides: {} },
    maxWallClockMs: 60_000,
    signal: new AbortController().signal,
    publishEvent: async (event) => {
      events.push(event.type);
    },
    writeSandboxRunArtifact: async (name) => name,
  };
}
