import { randomUUID } from 'node:crypto';

import {
  Freestyle,
  type CreateVmOptions,
  type ExecResult,
  type PtySession,
  type Vm,
} from 'freestyle';

import type { AppConfig } from '../../config.js';
import { assertExecSucceeded, normalizeRemotePath, shellQuote } from './sandbox-utils.js';
import type {
  SandboxExecOutput,
  SandboxExecResult,
  SandboxProvider,
  SandboxSession,
} from '../../types.js';
import { SandboxWorkerRunner, type SandboxWorkerRunnerDeps } from './sandbox-worker.js';

type SandboxWriteStreamOptions = NonNullable<Parameters<SandboxSession['fs']['writeStream']>[2]>;

// The agent user the prepared worker images ship, and where Codex auth is
// forwarded to; both providers land on the same layout so one image serves each.
const WORKER_USER = 'tenki';
const WORKER_HOME = '/home/tenki';

// The provider caps a one-shot exec at five minutes, which is why anything that
// can outlast it goes through the PTY instead.
const EXEC_TIMEOUT_MS = 300_000;

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

export interface FreestyleWorkerRunnerDeps extends SandboxWorkerRunnerDeps {
  createClient?: () => FreestyleClient;
}

export class FreestyleWorkerRunner extends SandboxWorkerRunner {
  constructor(config: AppConfig, env = process.env, deps: FreestyleWorkerRunnerDeps = {}) {
    super(config, env, new FreestyleSandboxProvider(config, env, deps), deps);
  }
}

export class FreestyleSandboxProvider implements SandboxProvider {
  readonly name = 'Freestyle';
  readonly apiTarget: string;
  private readonly createClient: () => FreestyleClient;

  constructor(
    private readonly config: AppConfig,
    private readonly env = process.env,
    deps: Pick<FreestyleWorkerRunnerDeps, 'createClient'> = {},
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
  }

  async create(options: Record<string, unknown>, signal: AbortSignal): Promise<SandboxSession> {
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

      await prepareWorkerUser(created.vm, normalizeRemotePath(this.config.worker.workspacePath));
      return new FreestyleSession(created.vm, created.vmId, stringRecord(options.env), signal);
    } catch (error) {
      await created.vm.delete().catch(() => undefined);
      throw error;
    }
  }

  async waitReady(_session: SandboxSession, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
  }

  async terminate(session: SandboxSession): Promise<void> {
    await (session as FreestyleSession).deleteVm();
  }
}

export class FreestyleSession implements SandboxSession {
  readonly fs = {
    readStream: (path: string) => this.vm.fs.readFileStream(path),
    writeStream: async (
      path: string,
      data: ReadableStream<Uint8Array>,
      options: SandboxWriteStreamOptions = {},
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
  ) {}

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
      onOutput?: (output: SandboxExecOutput) => void;
    } = {},
  ): Promise<SandboxExecResult> {
    const shellCommand = [command, ...(options.args ?? [])].map(shellQuote).join(' ');
    return options.onOutput
      ? this.execLong(shellCommand, options.onOutput)
      : this.execShort(shellCommand);
  }

  private async execShort(command: string): Promise<SandboxExecResult> {
    throwIfAborted(this.signal);
    const result = await this.vm.exec({
      command,
      linuxUser: WORKER_USER,
      env: workerEnvironment(this.env),
      timeoutMs: EXEC_TIMEOUT_MS,
    });
    return freestyleExecResult(command, result);
  }

  private async execLong(
    command: string,
    onOutput?: (output: SandboxExecOutput) => void,
  ): Promise<SandboxExecResult> {
    throwIfAborted(this.signal);
    const runId = randomUUID().replaceAll('-', '');
    const runDir = `/tmp/jardinero-${runId}`;
    const scriptPath = `${runDir}/run.sh`;
    const envPath = `${runDir}/env.sh`;

    const prepare = await this.vm.exec(
      `mkdir -p ${shellQuote(runDir)} && chown -R ${WORKER_USER}:${WORKER_USER} ${shellQuote(runDir)}`,
    );
    assertFreestyleExecSucceeded(prepare, 'prepare PTY command');
    await this.vm.fs.writeFile(envPath, renderShellEnvironment(workerEnvironment(this.env)), {
      mode: 0o600,
    });
    await this.vm.fs.writeFile(
      scriptPath,
      [
        '#!/bin/sh',
        // Preserve pipe-like output despite the PTY: no input echo and no LF-to-CRLF conversion.
        'stty -echo -onlcr',
        `set -a; . ${shellQuote(envPath)}; set +a`,
        `exec sh -lc ${shellQuote(command)}`,
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    const ownership = await this.vm.exec(
      `chown ${WORKER_USER}:${WORKER_USER} ${shellQuote(envPath)} ${shellQuote(scriptPath)}`,
    );
    assertFreestyleExecSucceeded(ownership, 'prepare PTY command ownership');

    type PtyTerminal = { exitCode: number } | { error: Error };
    const output: Uint8Array[] = [];
    let terminal: PtyTerminal | undefined;
    let wakeTerminal: ((value: PtyTerminal) => void) | undefined;
    const finish = (value: PtyTerminal): void => {
      if (terminal) return;
      terminal = value;
      wakeTerminal?.(value);
    };
    const waitForTerminal = (): Promise<PtyTerminal> =>
      terminal
        ? Promise.resolve(terminal)
        : new Promise((resolve) => {
            wakeTerminal = resolve;
          });
    let ptySession: PtySession | undefined;
    const workerPty = this.vm.linuxUser(WORKER_USER).pty;
    const abortHandler = (): void => {
      try {
        ptySession?.signal('sigkill');
      } catch {
        // VM deletion is the outer abort backstop; a closed socket needs no signal.
      }
      finish({ error: new Error('Run aborted.') });
    };

    try {
      ptySession = await workerPty.open({
        exec: `/bin/sh ${shellQuote(scriptPath)}`,
        cols: 120,
        rows: 30,
        onData: (data) => {
          // A PTY is one combined terminal stream, so it is exposed as stdout.
          const chunk = data.slice();
          output.push(chunk);
          onOutput?.({ data: chunk, isStderr: false, isFinal: false });
        },
        onExit: (exitCode) => finish({ exitCode }),
        onError: (error) => finish({ error: toError(error) }),
        onClose: ({ code, reason }) =>
          finish({
            error: new Error(
              `Freestyle PTY closed before command exit (code=${code}${reason ? `, reason=${reason}` : ''}).`,
            ),
          }),
      });
      this.signal.addEventListener('abort', abortHandler, { once: true });
      throwIfAborted(this.signal);

      const completed = await waitForTerminal();
      if ('error' in completed) throw completed.error;
      onOutput?.({ data: new Uint8Array(), isStderr: false, isFinal: true });
      const result: ExecResult = {
        stdout: new TextDecoder().decode(concatBytes(output)),
        stderr: '',
        statusCode: completed.exitCode,
      };
      return freestyleExecResult(command, result);
    } finally {
      this.signal.removeEventListener('abort', abortHandler);
      if (ptySession) {
        await workerPty.close(ptySession.sessionId).catch(() => undefined);
      }
    }
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
    // A run is many calls against one VM, and an ephemeral VM is deleted the moment
    // it stops, so any transient stop would take the clone with it. The run deletes
    // the VM itself; the TTL below reclaims it when the orchestrator never gets there.
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

async function prepareWorkerUser(vm: Vm, workspacePath: string): Promise<void> {
  const command = [
    `id -u ${WORKER_USER} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${WORKER_USER}`,
    // The workspace is configurable and need not sit under the worker's home, so
    // it is granted here; the run's first mkdir already runs as the worker user.
    `mkdir -p ${shellQuote(WORKER_HOME)} ${shellQuote(workspacePath)}`,
    `chown ${WORKER_USER}:${WORKER_USER} ${shellQuote(WORKER_HOME)} ${shellQuote(workspacePath)}`,
    // Codex auth forwarding shells out to sudo unconditionally, so a snapshot
    // without it fails much later, mid-run, with a raw shell error.
    `command -v sudo >/dev/null 2>&1 || { echo 'the worker snapshot must provide sudo' >&2; exit 1; }`,
    `printf '%s\\n' '${WORKER_USER} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/jardinero-worker`,
    'chmod 0440 /etc/sudoers.d/jardinero-worker',
  ].join(' && ');
  const result = await vm.exec({ command, timeoutMs: 60_000 });
  assertFreestyleExecSucceeded(result, 'prepare Freestyle worker user');
}

function freestyleExecResult(command: string, result: ExecResult): SandboxExecResult {
  const encoder = new TextEncoder();
  // A null status is how the provider reports a command its timeout killed; left
  // alone it reads downstream as an ordinary exit code 1.
  const timedOut = result.statusCode === null || result.statusCode === undefined;
  const detail = timedOut
    ? [result.stderr, `timed out after ${EXEC_TIMEOUT_MS / 1_000}s: ${command}`]
        .filter(Boolean)
        .join('\n')
    : (result.stderr ?? '');
  return {
    exitCode: result.statusCode ?? 1,
    stdout: encoder.encode(result.stdout ?? ''),
    stderr: encoder.encode(detail),
  };
}

function assertFreestyleExecSucceeded(result: ExecResult, label: string): void {
  if (result.statusCode === 0) return;
  const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim().slice(0, 500);
  throw new Error(
    `${label} failed with exit code ${result.statusCode ?? 'timeout'}${detail ? `: ${detail}` : ''}`,
  );
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

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
