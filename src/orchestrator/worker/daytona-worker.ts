import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  Daytona,
  DaytonaProcessExecutionTimeoutError,
  type CreateSandboxFromSnapshotParams,
  type Sandbox,
} from '@daytona/sdk';

import type { AppConfig } from '../../config.js';
import { logger } from '../../platform/logger.js';
import {
  assertExecSucceeded,
  buildGitCloneCommand,
  concatBytes,
  normalizeRemotePath,
  numberOption,
  renderShellEnvironment,
  shellQuote,
  streamToBytes,
  stringOption,
  stringRecord,
  throwIfAborted,
  WORKER_HOME,
  WORKER_USER,
  workerEnvironment,
} from './sandbox-utils.js';
import type {
  SandboxExecOutput,
  SandboxExecResult,
  SandboxProvider,
  SandboxSession,
} from '../../types.js';
import { SandboxWorkerRunner, type SandboxWorkerRunnerDeps } from './sandbox-worker.js';

type SandboxWriteStreamOptions = NonNullable<Parameters<SandboxSession['fs']['writeStream']>[2]>;

// The run's environment (tokens included) is sourced from this file because the
// sudo hop to the worker user strips inherited variables, and inlining them in
// the command would put secrets in the process list.
const WORKER_ENV_PATH = `${WORKER_HOME}/.jardinero-env.sh`;

// One-shot execs are capped so a wedged command cannot hold the daemon call
// forever; anything that can outlast this streams through a session instead.
const EXEC_TIMEOUT_SECONDS = 300;

// Creation waits for the runner to pull the worker snapshot, which can far
// outlast the SDK's 60s default on a cold pull.
const CREATE_TIMEOUT_SECONDS = 600;

// How many times the exit status is re-read and how long between reads; together
// they are the budget that has to outlast the daemon's recording gap.
const EXIT_CODE_ATTEMPTS = 8;
const EXIT_CODE_POLL_MS = 250;

// Command results the session consumes, structural because the SDK does not
// re-export its ExecuteResponse type from the package root.
interface DaytonaExecResponse {
  exitCode: number;
  result: string;
}

interface DaytonaClient {
  create(params: CreateSandboxFromSnapshotParams, options?: { timeout?: number }): Promise<Sandbox>;
}

export interface DaytonaWorkerRunnerDeps extends SandboxWorkerRunnerDeps {
  createClient?: () => DaytonaClient;
}

export class DaytonaWorkerRunner extends SandboxWorkerRunner {
  constructor(config: AppConfig, env = process.env, deps: DaytonaWorkerRunnerDeps = {}) {
    super(config, env, new DaytonaSandboxProvider(config, env, deps), deps);
  }
}

// unusedResourceOverrides names what an operator sized in vain: a Daytona sandbox
// takes its CPU and memory from the snapshot, so the config's never reach it.
export function unusedResourceOverrides(config: AppConfig): string[] {
  const repos = Object.entries(config.worker.repos)
    .filter(([, target]) => target.resources !== undefined)
    .map(([repo]) => repo);
  return config.worker.default.resources === undefined ? repos : ['default', ...repos];
}

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = 'Daytona';
  readonly apiTarget: string;
  private readonly createClient: () => DaytonaClient;
  private readonly log = logger.child('worker');

  constructor(
    private readonly config: AppConfig,
    private readonly env = process.env,
    deps: Pick<DaytonaWorkerRunnerDeps, 'createClient'> = {},
  ) {
    const apiUrl = env[config.worker.daytonaApiUrlEnv]?.trim();
    this.apiTarget = daytonaApiTarget(apiUrl);
    this.createClient =
      deps.createClient ??
      (() => {
        const apiKey = this.env[this.config.worker.daytonaApiKeyEnv];
        if (!apiKey) {
          throw new Error(`Missing ${this.config.worker.daytonaApiKeyEnv}.`);
        }
        return new Daytona({ apiKey, ...(apiUrl ? { apiUrl } : {}) });
      });
  }

  async create(options: Record<string, unknown>, signal: AbortSignal): Promise<SandboxSession> {
    throwIfAborted(signal);
    const configured = unusedResourceOverrides(this.config);
    if (configured.length > 0) {
      this.log.warn('worker.resources does not apply on the Daytona runner', { configured });
    }
    const client = this.createClient();
    const params = daytonaSandboxCreateParams(options);
    const sandbox = await client.create(params, { timeout: CREATE_TIMEOUT_SECONDS });
    try {
      throwIfAborted(signal);
      await prepareWorkerUser(
        sandbox,
        normalizeRemotePath(this.config.worker.workspacePath),
        workerEnvironment(stringRecord(options.env)),
      );
      return new DaytonaSession(sandbox, sandbox.id, signal);
    } catch (error) {
      await sandbox.delete().catch(() => undefined);
      throw error;
    }
  }

  // create() already waited for the running state, so readiness is only an
  // abort check.
  async waitReady(_session: SandboxSession, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
  }

  async terminate(session: SandboxSession): Promise<void> {
    await (session as DaytonaSession).deleteSandbox();
  }
}

export class DaytonaSession implements SandboxSession {
  readonly fs = {
    readStream: async (path: string) =>
      bytesToReadableStream(await this.sandbox.fs.downloadFile(path)),
    writeStream: async (
      path: string,
      data: ReadableStream<Uint8Array>,
      options: SandboxWriteStreamOptions = {},
    ) => {
      await installFileAsWorker(
        this.sandbox,
        path,
        toBuffer(await streamToBytes(data)),
        options.mode,
      );
    },
    mkdir: async (path: string) => {
      const quoted = shellQuote(path);
      const response = await this.sandbox.process.executeCommand(
        asRootCommand(`mkdir -p ${quoted} && chown ${WORKER_USER}:${WORKER_USER} ${quoted}`),
        undefined,
        undefined,
        EXEC_TIMEOUT_SECONDS,
      );
      assertDaytonaExecSucceeded(response, `create ${path}`);
    },
  };

  readonly git = {
    clone: async (url: string, options: { directory?: string } = {}) => {
      const directory = options.directory ?? `${WORKER_HOME}/workspace/repo`;
      const result = await this.execStreaming(buildGitCloneCommand(url, directory));
      assertExecSucceeded(result, 'clone repository');
    },
  };

  constructor(
    private readonly sandbox: Sandbox,
    readonly id: string,
    private readonly signal: AbortSignal,
  ) {}

  async deleteSandbox(): Promise<void> {
    await this.sandbox.delete();
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await installFileAsWorker(this.sandbox, path, toBuffer(content));
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.sandbox.fs.downloadFile(path);
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
      ? this.execStreaming(shellCommand, options.onOutput)
      : this.execShort(shellCommand);
  }

  private async execShort(command: string): Promise<SandboxExecResult> {
    throwIfAborted(this.signal);
    try {
      const response = await this.sandbox.process.executeCommand(
        workerCommand(command),
        undefined,
        undefined,
        EXEC_TIMEOUT_SECONDS,
      );
      return daytonaExecResult(response);
    } catch (error) {
      // The SDK reports a command its timeout killed as an error; left alone it
      // would fail the whole run instead of reading as the command's failure.
      if (error instanceof DaytonaProcessExecutionTimeoutError) {
        return {
          exitCode: 1,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode(`timed out after ${EXEC_TIMEOUT_SECONDS}s: ${command}`),
        };
      }
      throw error;
    }
  }

  private async execStreaming(
    command: string,
    onOutput?: (output: SandboxExecOutput) => void,
  ): Promise<SandboxExecResult> {
    throwIfAborted(this.signal);
    const process = this.sandbox.process;
    const sessionId = `jardinero-${randomUUID().replaceAll('-', '')}`;
    await process.createSession(sessionId);
    const encoder = new TextEncoder();
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let abortHandler: (() => void) | undefined;
    try {
      const started = await process.executeSessionCommand(sessionId, {
        command: workerCommand(command),
        runAsync: true,
      });
      const commandId = started.cmdId;
      if (!commandId) {
        throw new Error('Daytona returned no command id for the session command.');
      }

      const aborted = new Promise<never>((_, reject) => {
        abortHandler = () => {
          // Deleting the session kills its process; sandbox deletion is the
          // outer backstop when this races the daemon.
          void process.deleteSession(sessionId).catch(() => undefined);
          reject(new Error('Run aborted.'));
        };
        this.signal.addEventListener('abort', abortHandler, { once: true });
      });
      throwIfAborted(this.signal);

      const push = (chunk: string, isStderr: boolean): void => {
        const bytes = encoder.encode(chunk);
        (isStderr ? stderr : stdout).push(bytes);
        onOutput?.({ data: bytes, isStderr, isFinal: false });
      };
      const logs = process.getSessionCommandLogs(
        sessionId,
        commandId,
        (chunk) => push(chunk, false),
        (chunk) => push(chunk, true),
      );
      // An abort tears the log stream down mid-await; without a handler of its
      // own that late rejection would escape as unhandled and kill the process.
      logs.catch(() => undefined);
      await Promise.race([logs, aborted]);
      onOutput?.({ data: new Uint8Array(), isStderr: false, isFinal: true });

      return {
        exitCode: await this.awaitExitCode(sessionId, commandId),
        stdout: concatBytes(stdout),
        stderr: concatBytes(stderr),
      };
    } finally {
      if (abortHandler) this.signal.removeEventListener('abort', abortHandler);
      await process.deleteSession(sessionId).catch(() => undefined);
    }
  }

  // awaitExitCode waits for the status Daytona records once the command ends; the
  // log stream closes on any socket close, so it can still be absent here, and
  // reading that as a failure would discard a finished Codex run.
  private async awaitExitCode(sessionId: string, commandId: string): Promise<number> {
    const process = this.sandbox.process;
    for (let attempt = 0; attempt < EXIT_CODE_ATTEMPTS; attempt += 1) {
      throwIfAborted(this.signal);
      const completed = await process.getSessionCommand(sessionId, commandId);
      if (typeof completed.exitCode === 'number') return completed.exitCode;
      await delay(EXIT_CODE_POLL_MS);
    }
    throw new Error(
      `Daytona never reported an exit status for the session command after ${
        (EXIT_CODE_ATTEMPTS * EXIT_CODE_POLL_MS) / 1_000
      }s.`,
    );
  }
}

// The toolbox daemon uploads as the sandbox's default user, which cannot write
// into worker-owned directories; files land in /tmp first and move into place
// as root. The mode is always set because a staging upload arrives restrictive,
// which after the chown would leave the file unreadable to the daemon's own
// reads; 0644 is the default so readbacks keep working.
async function installFileAsWorker(
  sandbox: Sandbox,
  path: string,
  content: Buffer,
  mode = 0o644,
): Promise<void> {
  const staging = `/tmp/jardinero-upload-${randomUUID().replaceAll('-', '')}`;
  await sandbox.fs.uploadFile(content, staging);
  const quoted = shellQuote(path);
  const response = await sandbox.process.executeCommand(
    asRootCommand(
      `mv ${shellQuote(staging)} ${quoted} && chown ${WORKER_USER}:${WORKER_USER} ${quoted} && chmod ${mode.toString(8)} ${quoted}`,
    ),
    undefined,
    undefined,
    EXEC_TIMEOUT_SECONDS,
  );
  assertDaytonaExecSucceeded(response, `install ${path}`);
}

export function daytonaSandboxCreateParams(
  options: Record<string, unknown>,
): CreateSandboxFromSnapshotParams {
  const image = stringOption(options.image);
  const maxDurationMs = numberOption(options.maxDurationMs) ?? 30 * 60_000;
  return {
    name: daytonaSandboxName(stringOption(options.name) ?? ''),
    ...(image ? { snapshot: image } : {}),
    // A Codex run is one long session command with no API traffic in between,
    // which inactivity auto-stop (default 15 minutes) would read as idle and
    // kill mid-run; the TTL below is the reclaim path instead.
    autoStopInterval: 0,
    // Ephemeral deletes the sandbox the moment it stops, and the TTL destroys
    // it a margin past Jardinero's own wall clock when the orchestrator never
    // got to delete it (crash, kill -9).
    ephemeral: true,
    ttlMinutes: Math.ceil(maxDurationMs / 60_000) + 5,
    labels: sanitizeLabels(stringRecord(options.metadata)),
  };
}

export function daytonaSandboxName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63)
    .replace(/-$/g, '');
  return normalized || `jardinero-${randomUUID().slice(0, 8)}`;
}

function daytonaApiTarget(apiUrl: string | undefined): string {
  if (!apiUrl) return 'app.daytona.io';
  try {
    return new URL(apiUrl).host || 'Daytona API';
  } catch {
    return 'Daytona API';
  }
}

async function prepareWorkerUser(
  sandbox: Sandbox,
  workspacePath: string,
  env: Record<string, string>,
): Promise<void> {
  const setup = [
    `id -u ${WORKER_USER} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${WORKER_USER}`,
    // The workspace is configurable and need not sit under the worker's home, so
    // it is granted here; the run's first mkdir already runs as the worker user.
    `mkdir -p ${shellQuote(WORKER_HOME)} ${shellQuote(workspacePath)}`,
    `chown ${WORKER_USER}:${WORKER_USER} ${shellQuote(WORKER_HOME)} ${shellQuote(workspacePath)}`,
    // useradd creates the home 750 on Ubuntu, which blocks the non-root daemon
    // from traversing into it; without o+x every fs read under it answers 403.
    `chmod 755 ${shellQuote(WORKER_HOME)} ${shellQuote(workspacePath)}`,
    // Codex auth forwarding shells out to sudo unconditionally, so a snapshot
    // without it fails much later, mid-run, with a raw shell error.
    `command -v sudo >/dev/null 2>&1 || { echo 'the worker snapshot must provide sudo' >&2; exit 1; }`,
    `printf '%s\\n' '${WORKER_USER} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/jardinero-worker`,
    'chmod 0440 /etc/sudoers.d/jardinero-worker',
  ].join(' && ');
  const prepared = await sandbox.process.executeCommand(
    asRootCommand(setup),
    undefined,
    undefined,
    60,
  );
  assertDaytonaExecSucceeded(prepared, 'prepare Daytona worker user');

  await installFileAsWorker(sandbox, WORKER_ENV_PATH, toBuffer(renderShellEnvironment(env)), 0o600);
}

// Runs a command as the worker user with the run's environment sourced; the
// inner shell is what execRequired shaped (`sh '-lc' ...`), so login-shell PATH
// setup from the image still applies.
function workerCommand(command: string): string {
  const inner = `set -a; . ${shellQuote(WORKER_ENV_PATH)}; set +a; exec ${command}`;
  return `sudo -n -u ${WORKER_USER} sh -c ${shellQuote(inner)}`;
}

// The sandbox exec user is the snapshot's own (root on some images, a sudoer
// elsewhere), so root work has to work from either.
function asRootCommand(command: string): string {
  const quoted = shellQuote(command);
  return `if [ "$(id -u)" = 0 ]; then sh -c ${quoted}; else sudo -n sh -c ${quoted}; fi`;
}

function daytonaExecResult(response: DaytonaExecResponse): SandboxExecResult {
  // The daemon answers with stdout and stderr combined; expose it as stdout the
  // way the Freestyle PTY channel does.
  return {
    exitCode: response.exitCode,
    stdout: new TextEncoder().encode(response.result ?? ''),
    stderr: new Uint8Array(),
  };
}

function assertDaytonaExecSucceeded(response: DaytonaExecResponse, label: string): void {
  if (response.exitCode === 0) return;
  const detail = (response.result ?? '').trim().slice(0, 500);
  throw new Error(
    `${label} failed with exit code ${response.exitCode}${detail ? `: ${detail}` : ''}`,
  );
}

function bytesToReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
}

function sanitizeLabels(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels)
      .slice(0, 64)
      .map(([key, value]) => [key.slice(0, 63), value.slice(0, 63)]),
  );
}
