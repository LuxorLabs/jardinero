import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Vm } from 'freestyle';

import { loadConfig, type AppConfig } from '../../config.js';
import type { SandboxRun } from '../../store/types.js';
import type { SandboxRunContext } from '../sandbox-pool.js';
import {
  FreestyleSandboxProvider,
  FreestyleWorkerRunner,
  freestyleSlug,
  freestyleVmCreateOptions,
  renderShellEnvironment,
} from './freestyle-worker.js';

describe('FreestyleWorkerRunner', () => {
  test('When it is constructed without credentials then should defer authentication until a run', () => {
    assert.doesNotThrow(() => new FreestyleWorkerRunner(freestyleConfig(), {}));
  });

  test('When a run finishes then should drive it on a Freestyle VM and delete it', async () => {
    const fake = fakeVm({ streamedStdout: '{"type":"turn.completed"}\n' });
    const config = freestyleConfig();
    // api_key keeps Codex auth off the host's ~/.codex, which a unit test has no
    // business reading.
    config.worker.codexAuthMode = 'api_key';
    const env: NodeJS.ProcessEnv = {
      FREESTYLE_API_KEY: 'key',
      [config.worker.githubTokenEnv]: 'gh-token',
      [config.worker.codexApiKeyEnv]: 'codex-key',
    };
    const events: string[] = [];
    const runner = new FreestyleWorkerRunner(config, env, {
      createClient: () => fakeClient(fake),
    });

    const result = await runner.run(fakeContext(events));

    assert.equal(result.status, 'succeeded');
    assert.equal(result.sandboxSessionId, 'vm-1');
    assert.ok(events.includes('sandbox.ready'), events.join(','));
    assert.equal(fake.deleteCalls, 1);
  });
});

describe('FreestyleSandboxProvider.create', () => {
  const cases: Array<{
    name: string;
    options: Record<string, unknown>;
    resources?: { cpu: number; memory: number };
    aborted?: boolean;
    abortAfterCreate?: boolean;
    resizeError?: Error;
    wantCreateCalls: number;
    wantResize?: Record<string, number>;
    wantDeletes: number;
    wantError?: RegExp;
  }> = [
    {
      name: 'When the signal is already aborted then should create no VM',
      options: {},
      aborted: true,
      wantCreateCalls: 0,
      wantDeletes: 0,
      wantError: /Run aborted/,
    },
    {
      name: 'When the snapshot is smaller than requested then should grow it',
      options: { name: 'agent-fix-run', image: 'snapshot-1', cpuCores: 4, memoryMb: 8192 },
      resources: { cpu: 2, memory: 4096 },
      wantCreateCalls: 1,
      wantResize: { cpu: 4, memory: 8192 },
      wantDeletes: 0,
    },
    {
      name: 'When the snapshot already meets the requested size then should leave it unchanged',
      options: { name: 'agent-fix-run', image: 'snapshot-1', cpuCores: 2, memoryMb: 4096 },
      resources: { cpu: 4, memory: 8192 },
      wantCreateCalls: 1,
      wantDeletes: 0,
    },
    {
      name: 'When resize fails after creation then should delete the VM',
      options: { name: 'agent-fix-run', image: 'snapshot-1', cpuCores: 4 },
      resources: { cpu: 2, memory: 4096 },
      resizeError: new Error('resize failed'),
      wantCreateCalls: 1,
      wantResize: { cpu: 4 },
      wantDeletes: 1,
      wantError: /resize failed/,
    },
    {
      name: 'When the signal aborts during creation then should delete the VM',
      options: {},
      abortAfterCreate: true,
      wantCreateCalls: 1,
      wantDeletes: 1,
      wantError: /Run aborted/,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const fake = fakeVm({ resources: testCase.resources, resizeError: testCase.resizeError });
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
        assert.equal(session.id, 'vm-1');
      }

      assert.equal(createCalls, testCase.wantCreateCalls);
      assert.deepEqual(fake.resizeCalls[0], testCase.wantResize);
      assert.equal(fake.deleteCalls, testCase.wantDeletes);
    });
  }

  test('When the configured credential is absent then should reject before calling the API', async () => {
    const provider = new FreestyleSandboxProvider(freestyleConfig(), {});

    await assert.rejects(
      () => provider.create({}, new AbortController().signal),
      /Missing FREESTYLE_API_KEY/,
    );
  });
});

describe('FreestyleSandboxProvider.apiTarget', () => {
  const cases = [
    {
      name: 'When no override exists then should name the public API',
      value: undefined,
      want: 'beta-api.freestyle.sh',
    },
    {
      name: 'When an override is a URL then should name its host',
      value: 'https://api.example.test/v1',
      want: 'api.example.test',
    },
    {
      name: 'When an override is invalid then should use a generic name',
      value: 'not a URL',
      want: 'Freestyle API',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const env = testCase.value === undefined ? {} : { FREESTYLE_API_URL: testCase.value };

      const provider = new FreestyleSandboxProvider(freestyleConfig(), env);

      assert.equal(provider.apiTarget, testCase.want);
    });
  }
});

describe('FreestyleSandboxProvider.waitReady', () => {
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
      const fake = fakeVm();
      const provider = providerWith(fake);
      const controller = new AbortController();
      if (testCase.aborted) controller.abort();

      const act = () => provider.waitReady({} as never, controller.signal);
      if (testCase.wantError) await assert.rejects(act, testCase.wantError);
      else await assert.doesNotReject(act);
    });
  }
});

describe('FreestyleSandboxProvider.terminate', () => {
  test('When the session owns a VM then should delete it', async () => {
    const fake = fakeVm();
    const provider = providerWith(fake);
    const session = await provider.create({}, new AbortController().signal);

    await provider.terminate(session);

    assert.equal(fake.deleteCalls, 1);
  });
});

describe('FreestyleSession.exec', () => {
  const cases: Array<{
    name: string;
    vm?: FakeVmOptions;
    command: string;
    args?: string[];
    stream: boolean;
    abortWhileRunning?: boolean;
    wantExecCommand?: string;
    wantExitCode?: number;
    wantStdout?: string;
    wantStderr?: RegExp;
    wantChunks?: Array<{ text: string; stderr: boolean; final: boolean }>;
    wantPtySignals?: string[];
    wantPtyCloses?: number;
    wantError?: RegExp;
  }> = [
    {
      name: 'When no output sink is given then should run it as a one-shot exec',
      command: 'printf',
      args: ['hello world'],
      stream: false,
      wantExecCommand: "'printf' 'hello world'",
      wantExitCode: 0,
      wantStdout: '',
      wantPtyCloses: 0,
    },
    {
      // The provider answers a killed command with no status at all, so the
      // timeout has to be named or it reads as a plain failure.
      name: 'When a one-shot exec hits the provider timeout then should say so on stderr',
      vm: { execStatusCode: null },
      command: 'sleep',
      stream: false,
      wantExitCode: 1,
      wantStdout: '',
      wantStderr: /timed out after 300s/,
      wantPtyCloses: 0,
    },
    {
      name: 'When an output sink is given then should stream the combined PTY channel',
      vm: { streamedStdout: '{"type":"thread.started"}\n', streamedStderr: 'note\n' },
      command: 'sh',
      args: ['-lc', 'codex exec --json'],
      stream: true,
      wantExitCode: 0,
      wantStdout: '{"type":"thread.started"}\nnote\n',
      wantChunks: [
        { text: '{"type":"thread.started"}\n', stderr: false, final: false },
        { text: 'note\n', stderr: false, final: false },
        { text: '', stderr: false, final: true },
      ],
      wantPtyCloses: 1,
    },
    {
      name: 'When a PTY command exits unsuccessfully then should return its exit code',
      vm: { streamedStdout: 'failed\n', ptyExitCode: 23 },
      command: 'failing-command',
      stream: true,
      wantExitCode: 23,
      wantStdout: 'failed\n',
      wantPtyCloses: 1,
    },
    {
      name: 'When a PTY reports an error then should return error and close the session',
      vm: { ptyError: 'socket lost' },
      command: 'long-command',
      stream: true,
      wantError: /socket lost/,
      wantPtyCloses: 1,
    },
    {
      name: 'When a PTY closes before command exit then should return error with the close reason',
      vm: { ptyCloseBeforeExit: { code: 1006, reason: 'network lost' } },
      command: 'long-command',
      stream: true,
      wantError: /code=1006, reason=network lost/,
      wantPtyCloses: 1,
    },
    {
      name: 'When the run aborts while the PTY is active then should kill and close the session',
      vm: { holdPtyOpen: true },
      command: 'long-command',
      stream: true,
      abortWhileRunning: true,
      wantError: /Run aborted/,
      wantPtySignals: ['sigkill'],
      wantPtyCloses: 1,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const fake = fakeVm(testCase.vm);
      const controller = new AbortController();
      const session = await providerWith(fake).create({}, controller.signal);
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

      if (testCase.wantExecCommand) {
        assert.ok(
          fake.execCommands.includes(testCase.wantExecCommand),
          fake.execCommands.join(','),
        );
      }
      if (testCase.wantChunks) assert.deepEqual(chunks, testCase.wantChunks);
      assert.deepEqual(fake.ptySignals, testCase.wantPtySignals ?? []);
      assert.equal(fake.ptyCloseCalls, testCase.wantPtyCloses);
    });
  }
});

describe('FreestyleSession file access', () => {
  test('When files are written then should leave every one owned by the worker user', async () => {
    const fake = fakeVm();
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
    assert.ok(fake.execCommands.includes("chown tenki:tenki '/tmp/direct'"));
    assert.ok(fake.execCommands.includes("chown tenki:tenki '/tmp/stream'"));
    assert.ok(fake.execCommands.includes("chown tenki:tenki '/tmp/directory'"));
  });
});

describe('FreestyleSession.git.clone', () => {
  test('When a clone is requested then should pass the token through a helper, never the URL', async () => {
    const fake = fakeVm();
    const session = await providerWith(fake).create(
      { env: { GITHUB_TOKEN: 'top-secret' } },
      new AbortController().signal,
    );

    assert.ok(session.git);
    await session.git.clone('https://github.com/example/repo.git', {
      directory: '/home/tenki/workspace/repo',
    });

    const launch = fake.ptyCommands[0];
    assert.ok(launch);
    const scriptPath = launch.match(/\/tmp\/jardinero-[a-f0-9]+\/run\.sh/)?.[0];
    assert.ok(scriptPath);
    const script = await fake.fs.readTextFile(scriptPath);
    assert.match(script, /credential\.helper/);
    assert.doesNotMatch(script, /top-secret/);
  });
});

describe('freestyleVmCreateOptions', () => {
  const cases: Array<{
    name: string;
    input: Record<string, unknown>;
    check(options: ReturnType<typeof freestyleVmCreateOptions>): void;
  }> = [
    {
      name: 'When Tenki-shaped options are complete then should map them to a Freestyle VM',
      input: {
        name: 'Agent Fix 123',
        image: 'snapshot-1',
        maxDurationMs: 60_500,
        metadata: { run_id: 'run-1' },
      },
      check: (options) => {
        assert.equal(options.slug, 'agent-fix-123');
        assert.equal(options.displayName, 'Agent Fix 123');
        assert.equal(options.snapshotId, 'snapshot-1');
        assert.equal(options.ttlSeconds, 361);
        assert.deepEqual(options.metadata, { run_id: 'run-1' });
      },
    },
    {
      name: 'When optional values are absent then should use bounded disposable defaults',
      input: {},
      check: (options) => {
        assert.match(options.slug ?? '', /^jardinero-[a-f0-9]{8}$/);
        assert.equal(options.snapshotId, undefined);
        assert.equal(options.ttlSeconds, 2100);
      },
    },
    {
      name: 'When metadata exceeds provider limits then should truncate it',
      input: { metadata: { ['k'.repeat(80)]: 'v'.repeat(80) } },
      check: (options) => {
        const [entry] = Object.entries(options.metadata ?? {});
        assert.equal(entry?.[0].length, 63);
        assert.equal(entry?.[1].length, 63);
      },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const options = freestyleVmCreateOptions(testCase.input);

      testCase.check(options);
      assert.deepEqual(options.persistence, { type: 'persistent' });
      assert.equal(options.automaticRestart, true);
      assert.deepEqual(options.firewall, {
        rules: [{ action: 'allow', source: {}, destination: { public: true } }],
      });
    });
  }
});

describe('freestyleSlug', () => {
  const cases = [
    {
      name: 'When the value needs normalization then should return a valid slug',
      value: ' A--B_C ',
      want: 'a-b-c',
    },
    {
      name: 'When the value is too long then should cap it',
      value: 'a'.repeat(80),
      want: 'a'.repeat(63),
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(freestyleSlug(testCase.value), testCase.want);
    });
  }

  test('When the value has no slug characters then should mint a slug', () => {
    assert.match(freestyleSlug('___'), /^jardinero-[a-f0-9]{8}$/);
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

interface FakeVm extends Vm {
  resizeCalls: Array<Record<string, number>>;
  deleteCalls: number;
  execCommands: string[];
  ptyCommands: string[];
  ptySignals: string[];
  ptyCloseCalls: number;
}

function providerWith(fake: FakeVm, onCreate: () => void = () => undefined) {
  return new FreestyleSandboxProvider(
    freestyleConfig(),
    { FREESTYLE_API_KEY: 'key' },
    {
      createClient: () => ({
        vms: {
          create: async () => {
            onCreate();
            return {
              vm: fake,
              vmId: 'vm-1',
              data: { resources: fakeResources.get(fake) ?? { cpu: 4, memory: 8192 } },
            };
          },
        },
      }),
    },
  );
}

const fakeResources = new WeakMap<FakeVm, { cpu: number; memory: number }>();

interface FakeVmOptions {
  resources?: { cpu: number; memory: number };
  resizeError?: Error;
  // null is how the provider reports a command its timeout killed.
  execStatusCode?: number | null;
  streamedStdout?: string;
  streamedStderr?: string;
  ptyExitCode?: number;
  ptyError?: unknown;
  ptyCloseBeforeExit?: { code: number; reason: string };
  holdPtyOpen?: boolean;
}

function fakeVm(options: FakeVmOptions = {}): FakeVm {
  const files = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const resizeCalls: Array<Record<string, number>> = [];
  const execCommands: string[] = [];
  const ptyCommands: string[] = [];
  const ptySignals: string[] = [];
  let deleteCalls = 0;
  let ptyCloseCalls = 0;
  const fs = {
    writeFile: async (path: string, content: string | Uint8Array) => {
      files.set(path, typeof content === 'string' ? encoder.encode(content) : content);
    },
    readFile: async (path: string, readOptions: { offset?: number; length?: number } = {}) => {
      const value = files.get(path) ?? new Uint8Array();
      const offset = readOptions.offset ?? 0;
      return value.slice(
        offset,
        readOptions.length === undefined ? undefined : offset + readOptions.length,
      );
    },
    readTextFile: async (path: string) => decoder.decode(files.get(path) ?? new Uint8Array()),
    readFileStream: async (path: string) => {
      const value = files.get(path) ?? new Uint8Array();
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(value);
          controller.close();
        },
      });
    },
    mkdir: async () => undefined,
    exists: async (path: string) => files.has(path),
    stat: async (path: string) => ({ size: files.get(path)?.byteLength ?? 0 }),
  };
  const vm = {
    fs,
    resizeCalls,
    execCommands,
    ptyCommands,
    ptySignals,
    get deleteCalls() {
      return deleteCalls;
    },
    get ptyCloseCalls() {
      return ptyCloseCalls;
    },
    resize: async (resize: Record<string, number>) => {
      resizeCalls.push(resize);
      if (options.resizeError) throw options.resizeError;
    },
    delete: async () => {
      deleteCalls += 1;
    },
    linuxUser: () => ({
      pty: {
        open: async (request: {
          exec?: string;
          onData?: (data: Uint8Array) => void;
          onExit?: (exitCode: number) => void;
          onError?: (error: unknown) => void;
          onClose?: (info: { code: number; reason: string }) => void;
        }) => {
          ptyCommands.push(request.exec ?? '');
          if (!options.holdPtyOpen) {
            queueMicrotask(() => {
              if (options.ptyError !== undefined) {
                request.onError?.(options.ptyError);
                return;
              }
              if (options.ptyCloseBeforeExit) {
                request.onClose?.(options.ptyCloseBeforeExit);
                return;
              }
              const stdout = encoder.encode(options.streamedStdout ?? '');
              const stderr = encoder.encode(options.streamedStderr ?? '');
              if (stdout.byteLength > 0) request.onData?.(stdout);
              if (stderr.byteLength > 0) request.onData?.(stderr);
              request.onExit?.(options.ptyExitCode ?? 0);
            });
          }
          return {
            sessionId: 7,
            signal: (signal: string) => {
              ptySignals.push(signal);
            },
          };
        },
        close: async () => {
          ptyCloseCalls += 1;
          return { sessionId: 7 };
        },
      },
    }),
    exec: async (request: string | { command: string; linuxUser?: string }) => {
      const command = typeof request === 'string' ? request : request.command;
      execCommands.push(command);
      // Only the session's own exec names a linuxUser; the root-level prepare and
      // chown commands have to keep succeeding whatever the case scripts.
      const isSessionExec = typeof request !== 'string' && request.linuxUser !== undefined;
      const statusCode =
        isSessionExec && options.execStatusCode !== undefined ? options.execStatusCode : 0;
      return { stdout: '', stderr: '', statusCode };
    },
  } as unknown as FakeVm;
  fakeResources.set(vm, options.resources ?? { cpu: 4, memory: 8192 });
  return vm;
}

function freestyleConfig(): AppConfig {
  const config = loadConfig();
  config.worker.runner = 'freestyle';
  config.worker.default.image = 'snapshot-1';
  return config;
}

function fakeClient(fake: FakeVm) {
  return {
    vms: {
      create: async () => ({
        vm: fake,
        vmId: 'vm-1',
        data: { resources: fakeResources.get(fake) ?? { cpu: 4, memory: 8192 } },
      }),
    },
  };
}

function fakeContext(events: string[]): SandboxRunContext {
  const sandboxRun: SandboxRun = {
    id: 'run-freestyle-test',
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
