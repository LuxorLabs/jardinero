import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Freestyle, type CreateVmOptions, type ExecResult, type Vm } from 'freestyle';

import type { AppConfig } from '../../config.js';
import { assertExecSucceeded, shellQuote } from '../../adapters/tenki/tenki-utils.js';
import type {
  WorkerSandboxExecOutput,
  WorkerSandboxExecResult,
  WorkerSandboxProvider,
  WorkerSandboxSession,
} from '../../types.js';
import type { SandboxRunner } from '../sandbox-pool.js';
import { SandboxWorkerRunner, type SandboxWorkerRunnerDeps } from './tenki-worker.js';

type WorkerSandboxWriteStreamOptions = NonNullable<
  Parameters<WorkerSandboxSession['fs']['writeStream']>[2]
>;

const WORKER_USER = 'tenki';
const WORKER_HOME = '/home/tenki';
const STREAM_POLL_INTERVAL_MS = 500;

interface FreestyleClient {
  vms: {
    create(options: CreateVmOptions): Promise<{
      vm: Vm;
      vmId: string;
      data: {
        resources: {
          cpu: number;
          memory: number;
        };
      };
    }>;
  };
}

export interface FreestyleWorkerRunnerDeps
  extends Omit<SandboxWorkerRunnerDeps, 'provider' | 'loadSdk' | 'terminateSession'> {
  createClient?: () => FreestyleClient;
  pollDelay?: (signal: AbortSignal) => Promise<void>;
}

export class FreestyleWorkerRunner implements SandboxRunner {
  private readonly runner: SandboxWorkerRunner;

  constructor(config: AppConfig, env = process.env, deps: FreestyleWorkerRunnerDeps = {}) {
    const provider = new FreestyleSandboxProvider(config, env, deps);
    this.runner = new SandboxWorkerRunner(config, env, {
      getPullRequestHead: deps.getPullRequestHead,
      sandboxReadyRetryDelayMs: deps.sandboxReadyRetryDelayMs,
      provider,
    });
  }

  run(...args: Parameters<SandboxRunner['run']>): ReturnType<SandboxRunner['run']> {
    return this.runner.run(...args);
  }
}

export class FreestyleSandboxProvider implements WorkerSandboxProvider {
  readonly name = 'Freestyle';
  readonly apiTarget: string;
  private readonly createClient: () => FreestyleClient;
  private readonly pollDelay: (signal: AbortSignal) => Promise<void>;

  constructor(
    private readonly config: AppConfig,
    private readonly env = process.env,
    deps: Pick<FreestyleWorkerRunnerDeps, 'createClient' | 'pollDelay'> = {},
  ) {
    const baseUrl = env[config.worker.freestyleApiUrlEnv]?.trim();
    this.apiTarget = freestyleApiTarget(baseUrl);
    this.createClient =
      deps.createClient ??
      (() => {
        const apiKey = this.env[this.config.worker.freestyleApiKeyEnv];
        if (!apiKey) {
          throw new Error(`Missing ${this.config.worker.freestyleApiKeyEnv}.`);
        }
        return new Freestyle({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
      });
    this.pollDelay =
      deps.pollDelay ??
      ((signal) => delay(STREAM_POLL_INTERVAL_MS, undefined, { signal }).then(() => undefined));
  }

  async create(
    options: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<WorkerSandboxSession> {
    throwIfAborted(signal);
    const client = this.createClient();
    const createOptions = freestyleVmCreateOptions(options);
    const created = await client.vms.create(createOptions);
    try {
      throwIfAborted(signal);
      const wantedCpu = numberOption(options.cpuCores);
      const wantedMemory = numberOption(options.memoryMb);
      const resize = {
        ...(wantedCpu !== undefined && wantedCpu > created.data.resources.cpu
          ? { cpu: wantedCpu }
          : {}),
        ...(wantedMemory !== undefined && wantedMemory > created.data.resources.memory
          ? { memory: wantedMemory }
          : {}),
      };
      if (Object.keys(resize).length > 0) await created.vm.resize(resize);

      await prepareWorkerUser(created.vm);
      return new FreestyleSession(
        created.vm,
        created.vmId,
        stringRecord(options.env),
        signal,
        this.pollDelay,
      ).asWorkerSandboxSession();
    } catch (error) {
      await created.vm.delete().catch(() => undefined);
      throw error;
    }
  }

  async waitReady(_session: WorkerSandboxSession, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
  }

  async terminate(session: WorkerSandboxSession): Promise<void> {
    await (session as unknown as FreestyleSessionHandle).deleteVm();
  }
}

interface FreestyleSessionHandle {
  deleteVm(): Promise<void>;
}

class FreestyleSession implements FreestyleSessionHandle {
  readonly fs = {
    readStream: (path: string) => this.vm.fs.readFileStream(path),
    writeStream: async (
      path: string,
      data: ReadableStream<Uint8Array>,
      options: WorkerSandboxWriteStreamOptions = {},
    ) => {
      await this.vm.fs.writeFile(path, await streamToBytes(data), { mode: options.mode });
      await this.chownWorker(path);
    },
    mkdir: async (path: string) => {
      await this.vm.fs.mkdir(path);
      await this.chownWorker(path);
    },
  };

  readonly git = {
    clone: async (url: string, options: { directory?: string } = {}) => {
      const directory = options.directory ?? `${WORKER_HOME}/workspace/repo`;
      const credentialHelper =
        '!f() { if [ "$1" = get ]; then echo username=x-access-token; echo "password=$GITHUB_TOKEN"; fi; }; f';
      const result = await this.execLong(
        `git -c credential.helper=${shellQuote(credentialHelper)} clone ${shellQuote(url)} ${shellQuote(directory)}`,
      );
      assertExecSucceeded(result, 'clone repository');
    },
  };

  constructor(
    private readonly vm: Vm,
    readonly id: string,
    private readonly env: Record<string, string>,
    private readonly signal: AbortSignal,
    private readonly pollDelay: (signal: AbortSignal) => Promise<void>,
  ) {}

  asWorkerSandboxSession(): WorkerSandboxSession {
    return this as unknown as WorkerSandboxSession;
  }

  async deleteVm(): Promise<void> {
    await this.vm.delete();
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.vm.fs.writeFile(path, content);
    await this.chownWorker(path);
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.vm.fs.readFile(path);
  }

  async exec(
    command: string,
    options: {
      args?: string[];
      onOutput?: (output: WorkerSandboxExecOutput) => void;
    } = {},
  ): Promise<WorkerSandboxExecResult> {
    const shellCommand = [command, ...(options.args ?? [])].map(shellQuote).join(' ');
    return options.onOutput
      ? this.execLong(shellCommand, options.onOutput)
      : this.execShort(shellCommand);
  }

  private async execShort(command: string): Promise<WorkerSandboxExecResult> {
    throwIfAborted(this.signal);
    const startedAt = Date.now();
    const result = await this.vm.exec({
      command,
      linuxUser: WORKER_USER,
      env: workerEnvironment(this.env),
      timeoutMs: 300_000,
    });
    return freestyleExecResult(command, result, Date.now() - startedAt);
  }

  private async execLong(
    command: string,
    onOutput?: (output: WorkerSandboxExecOutput) => void,
  ): Promise<WorkerSandboxExecResult> {
    throwIfAborted(this.signal);
    const startedAt = Date.now();
    const runId = randomUUID().replaceAll('-', '');
    const runDir = `/tmp/jardinero-${runId}`;
    const stdoutPath = `${runDir}/stdout`;
    const stderrPath = `${runDir}/stderr`;
    const statusPath = `${runDir}/status`;
    const scriptPath = `${runDir}/run.sh`;
    const envPath = `${runDir}/env.sh`;
    const unit = `jardinero-${runId.slice(0, 24)}`;

    const prepare = await this.vm.exec(
      `mkdir -p ${shellQuote(runDir)} && touch ${shellQuote(stdoutPath)} ${shellQuote(stderrPath)} && chown -R ${WORKER_USER}:${WORKER_USER} ${shellQuote(runDir)}`,
    );
    assertFreestyleExecSucceeded(prepare, 'prepare streamed command');
    await this.vm.fs.writeFile(envPath, renderShellEnvironment(workerEnvironment(this.env)), {
      mode: 0o600,
    });
    await this.vm.fs.writeFile(
      scriptPath,
      [
        '#!/bin/sh',
        `set -a; . ${shellQuote(envPath)}; set +a`,
        `sh -lc ${shellQuote(command)} >${shellQuote(stdoutPath)} 2>${shellQuote(stderrPath)}`,
        'code=$?',
        `printf '%s' "$code" >${shellQuote(`${statusPath}.tmp`)}`,
        `mv ${shellQuote(`${statusPath}.tmp`)} ${shellQuote(statusPath)}`,
        'exit "$code"',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    const ownership = await this.vm.exec(
      `chown ${WORKER_USER}:${WORKER_USER} ${shellQuote(envPath)} ${shellQuote(scriptPath)}`,
    );
    assertFreestyleExecSucceeded(ownership, 'prepare streamed command ownership');

    const launch = await this.vm.exec({
      command:
        `systemd-run --quiet --collect --unit=${shellQuote(unit)} ` +
        `--uid=${shellQuote(WORKER_USER)} --gid=${shellQuote(WORKER_USER)} ` +
        `--working-directory=${shellQuote(WORKER_HOME)} /bin/sh ${shellQuote(scriptPath)}`,
      timeoutMs: 30_000,
    });
    assertFreestyleExecSucceeded(launch, 'start streamed command');

    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let stdoutOffset = 0;
    let stderrOffset = 0;
    const pump = async (isFinal: boolean): Promise<void> => {
      const nextStdout = await readFileGrowth(this.vm, stdoutPath, stdoutOffset);
      stdoutOffset += nextStdout.byteLength;
      if (nextStdout.byteLength > 0) stdout.push(nextStdout);
      if (nextStdout.byteLength > 0 || isFinal) {
        onOutput?.({ data: nextStdout, isStderr: false, isFinal });
      }

      const nextStderr = await readFileGrowth(this.vm, stderrPath, stderrOffset);
      stderrOffset += nextStderr.byteLength;
      if (nextStderr.byteLength > 0) stderr.push(nextStderr);
      if (nextStderr.byteLength > 0 || isFinal) {
        onOutput?.({ data: nextStderr, isStderr: true, isFinal });
      }
    };

    while (!(await this.vm.fs.exists(statusPath))) {
      throwIfAborted(this.signal);
      await pump(false);
      await this.pollDelay(this.signal);
    }
    await pump(true);
    const exitCode = Number.parseInt(await this.vm.fs.readTextFile(statusPath), 10);
    const result: ExecResult = {
      stdout: new TextDecoder().decode(concatBytes(stdout)),
      stderr: new TextDecoder().decode(concatBytes(stderr)),
      statusCode: Number.isFinite(exitCode) ? exitCode : 1,
    };
    return freestyleExecResult(command, result, Date.now() - startedAt);
  }

  private async chownWorker(path: string): Promise<void> {
    const result = await this.vm.exec(`chown ${WORKER_USER}:${WORKER_USER} ${shellQuote(path)}`);
    assertFreestyleExecSucceeded(result, `set worker ownership on ${path}`);
  }
}

export function freestyleVmCreateOptions(options: Record<string, unknown>): CreateVmOptions {
  const name = stringOption(options.name) ?? `jardinero-${randomUUID().slice(0, 8)}`;
  const image = stringOption(options.image);
  const maxDurationMs = numberOption(options.maxDurationMs) ?? 30 * 60_000;
  return {
    slug: freestyleSlug(name),
    displayName: name.slice(0, 63),
    ...(image ? { snapshotId: image } : {}),
    persistence: { type: 'persistent' },
    automaticRestart: true,
    ttlSeconds: Math.ceil(maxDurationMs / 1_000) + 300,
    metadata: sanitizeMetadata(stringRecord(options.metadata)),
    firewall: {
      rules: [{ action: 'allow', source: {}, destination: { public: true } }],
    },
  };
}

export function freestyleSlug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63)
    .replace(/-$/g, '');
  return normalized || `jardinero-${randomUUID().slice(0, 8)}`;
}

export function renderShellEnvironment(env: Record<string, string>): string {
  return `${Object.entries(env)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
    .join('\n')}\n`;
}

function freestyleApiTarget(baseUrl: string | undefined): string {
  if (!baseUrl) return 'beta-api.freestyle.sh';
  try {
    return new URL(baseUrl).host || 'Freestyle API';
  } catch {
    return 'Freestyle API';
  }
}

async function prepareWorkerUser(vm: Vm): Promise<void> {
  const command = [
    `id -u ${WORKER_USER} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${WORKER_USER}`,
    `mkdir -p ${WORKER_HOME}`,
    `chown ${WORKER_USER}:${WORKER_USER} ${WORKER_HOME}`,
    `if command -v sudo >/dev/null 2>&1; then printf '%s\\n' '${WORKER_USER} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/jardinero-worker; chmod 0440 /etc/sudoers.d/jardinero-worker; fi`,
  ].join(' && ');
  const result = await vm.exec({ command, timeoutMs: 60_000 });
  assertFreestyleExecSucceeded(result, 'prepare Freestyle worker user');
}

function freestyleExecResult(
  command: string,
  result: ExecResult,
  durationMs: number,
): WorkerSandboxExecResult {
  const stdout = new TextEncoder().encode(result.stdout ?? '');
  const stderr = new TextEncoder().encode(result.stderr ?? '');
  const exitCode = result.statusCode ?? 1;
  return {
    sessionId: '',
    command,
    args: [],
    status: exitCode === 0 ? 'SUCCEEDED' : 'FAILED',
    exitCode,
    durationMs,
    outputs: [],
    stdout,
    stderr,
  };
}

function assertFreestyleExecSucceeded(result: ExecResult, label: string): void {
  if (result.statusCode === 0) return;
  const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim().slice(0, 500);
  throw new Error(
    `${label} failed with exit code ${result.statusCode ?? 'timeout'}${detail ? `: ${detail}` : ''}`,
  );
}

async function readFileGrowth(vm: Vm, path: string, offset: number): Promise<Uint8Array> {
  const stat = await vm.fs.stat(path);
  if (stat.size <= offset) return new Uint8Array();
  return vm.fs.readFile(path, { offset, length: stat.size - offset });
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatBytes(chunks);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function sanitizeMetadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata)
      .slice(0, 64)
      .map(([key, value]) => [key.slice(0, 63), value.slice(0, 63)]),
  );
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberOption(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function workerEnvironment(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    HOME: WORKER_HOME,
    USER: WORKER_USER,
    LOGNAME: WORKER_USER,
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Run aborted.');
}
