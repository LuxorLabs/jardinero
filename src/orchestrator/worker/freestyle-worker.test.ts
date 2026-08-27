import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Vm } from 'freestyle';

import { loadConfig, type AppConfig } from '../../config.js';
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

describe('Freestyle sandbox session execution', () => {
  test('When an output sink is supplied then should stream both channels and return their result', async () => {
    const fake = fakeVm({
      streamedStdout: '{"type":"thread.started"}\n',
      streamedStderr: 'note\n',
    });
    const provider = providerWith(fake);
    const session = await provider.create(
      { env: { GITHUB_TOKEN: 'secret' } },
      new AbortController().signal,
    );
    const output: Array<{ text: string; stderr: boolean; final: boolean }> = [];

    assert.ok(session.exec);
    const result = await session.exec('sh', {
      args: ['-lc', 'codex exec --json'],
      onOutput: (chunk) => {
        output.push({
          text: new TextDecoder().decode(chunk.data),
          stderr: chunk.isStderr,
          final: chunk.isFinal,
        });
      },
    });

    assert.notEqual(typeof result, 'string');
    if (typeof result === 'string') return;
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout instanceof Uint8Array);
    assert.ok(result.stderr instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(result.stdout), '{"type":"thread.started"}\n');
    assert.equal(new TextDecoder().decode(result.stderr), 'note\n');
    assert.deepEqual(output, [
      { text: '{"type":"thread.started"}\n', stderr: false, final: true },
      { text: 'note\n', stderr: true, final: true },
    ]);
    assert.ok(fake.execCommands.some((command) => command.includes('systemd-run')));
  });

  test('When a streamed command is still running then should emit incremental and final chunks', async () => {
    const fake = fakeVm({
      streamedStdout: 'first\n',
      streamedStderr: 'warning\n',
      streamPollsBeforeComplete: 1,
    });
    const session = await providerWith(fake).create({}, new AbortController().signal);
    const output: Array<{ text: string; stderr: boolean; final: boolean }> = [];

    assert.ok(session.exec);
    const result = await session.exec('long-command', {
      onOutput: (chunk) => {
        output.push({
          text: new TextDecoder().decode(chunk.data),
          stderr: chunk.isStderr,
          final: chunk.isFinal,
        });
      },
    });

    assert.notEqual(typeof result, 'string');
    assert.deepEqual(output, [
      { text: 'first\n', stderr: false, final: false },
      { text: 'warning\n', stderr: true, final: false },
      { text: '', stderr: false, final: true },
      { text: '', stderr: true, final: true },
    ]);
  });

  test('When using the session facade then should execute short commands and preserve worker-owned files', async () => {
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
    const readStream = await session.fs.readStream('/tmp/stream');
    assert.equal(await new Response(readStream).text(), 'streamed');
    assert.ok(session.exec);
    const result = await session.exec('printf', { args: ['hello world'] });

    assert.notEqual(typeof result, 'string');
    if (typeof result === 'string') return;
    assert.equal(result.status, 'SUCCEEDED');
    assert.ok(fake.execCommands.includes("'printf' 'hello world'"));
    assert.ok(fake.execCommands.includes("chown tenki:tenki '/tmp/direct'"));
    assert.ok(fake.execCommands.includes("chown tenki:tenki '/tmp/stream'"));
    assert.ok(fake.execCommands.includes("chown tenki:tenki '/tmp/directory'"));
  });

  test('When git clone is requested then should use the token helper without placing a token in the URL', async () => {
    const fake = fakeVm();
    const session = await providerWith(fake).create(
      { env: { GITHUB_TOKEN: 'top-secret' } },
      new AbortController().signal,
    );

    assert.ok(session.git);
    await session.git.clone('https://github.com/example/repo.git', {
      directory: '/home/tenki/workspace/repo',
    });

    const launch = fake.execCommands.find((command) => command.includes('systemd-run'));
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
      pollDelay: async () => undefined,
    },
  );
}

const fakeResources = new WeakMap<FakeVm, { cpu: number; memory: number }>();

function fakeVm(
  options: {
    resources?: { cpu: number; memory: number };
    resizeError?: Error;
    streamedStdout?: string;
    streamedStderr?: string;
    streamPollsBeforeComplete?: number;
  } = {},
): FakeVm {
  const files = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const resizeCalls: Array<Record<string, number>> = [];
  const execCommands: string[] = [];
  let deleteCalls = 0;
  let pendingStatusPath: string | undefined;
  let streamPollsRemaining = options.streamPollsBeforeComplete ?? 0;
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
    exists: async (path: string) => {
      if (path === pendingStatusPath && streamPollsRemaining > 0) {
        streamPollsRemaining -= 1;
        return false;
      }
      if (path === pendingStatusPath && !files.has(path)) files.set(path, encoder.encode('0'));
      return files.has(path);
    },
    stat: async (path: string) => ({ size: files.get(path)?.byteLength ?? 0 }),
  };
  const vm = {
    fs,
    resizeCalls,
    execCommands,
    get deleteCalls() {
      return deleteCalls;
    },
    resize: async (resize: Record<string, number>) => {
      resizeCalls.push(resize);
      if (options.resizeError) throw options.resizeError;
    },
    delete: async () => {
      deleteCalls += 1;
    },
    exec: async (request: string | { command: string }) => {
      const command = typeof request === 'string' ? request : request.command;
      execCommands.push(command);
      if (command.includes('systemd-run')) {
        const runDir = command.match(/\/tmp\/jardinero-[a-f0-9]+/)?.[0];
        assert.ok(runDir);
        files.set(`${runDir}/stdout`, encoder.encode(options.streamedStdout ?? ''));
        files.set(`${runDir}/stderr`, encoder.encode(options.streamedStderr ?? ''));
        pendingStatusPath = `${runDir}/status`;
        if (streamPollsRemaining === 0) files.set(pendingStatusPath, encoder.encode('0'));
      }
      return { stdout: '', stderr: '', statusCode: 0 };
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
