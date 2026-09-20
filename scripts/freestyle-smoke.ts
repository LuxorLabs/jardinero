import '../src/env.js';

import { randomUUID } from 'node:crypto';

import { DEFAULT_BASE_URL } from 'freestyle';

import { loadConfig, resolveWorkerImage } from '../src/config.js';
import { FreestyleSandboxProvider } from '../src/orchestrator/worker/freestyle-worker.js';
import {
  assertExecSucceeded,
  execStderr,
  execStdout,
  normalizeRemotePath,
  remoteJoin,
  shellQuote,
  WORKER_HOME,
  WORKER_USER,
} from '../src/orchestrator/worker/sandbox-utils.js';
import type { SandboxExecResult, SandboxSession } from '../src/types.js';

interface CliOptions {
  skipPty: boolean;
}

interface Probe {
  label: string;
  command: string;
  want: string;
}

const config = loadConfig();
const options = parseCliOptions(process.argv.slice(2));
const workspacePath = normalizeRemotePath(config.worker.workspacePath);
const provider = new FreestyleSandboxProvider(config, process.env);
const runAbort = new AbortController();

let session: SandboxSession | undefined;
let completed = false;
let teardownError: unknown;

reportApiTarget();

try {
  const createOptions = vmCreateOptions();
  console.log('creating Freestyle VM');
  console.log(redactedJson(createOptions));
  session = await provider.create(createOptions, runAbort.signal);
  console.log(`vm ready: ${session.id}`);
  await provider.waitReady(session, runAbort.signal);

  await checkProvisioning(session);
  await checkFileApi(session);
  await checkExec(session);
  if (options.skipPty) {
    console.log('skipping the PTY check');
  } else {
    await checkPty(session);
  }

  completed = true;
} finally {
  if (session) {
    console.log('deleting VM');
    await provider.terminate(session).catch((error: unknown) => {
      teardownError = error;
      console.error(`delete failed: ${message(error)}`);
    });
  }
}

// `terminate` is part of the provider contract this exists to check, and a VM
// left running costs money until its TTL, so a failed teardown fails the run.
// Only reachable when the body succeeded, so its error still wins over this one.
if (teardownError) {
  throw teardownError;
}

if (completed) {
  console.log('freestyle smoke ok');
  process.exit(0);
}

// The provider carries this host into run context and into every error it
// raises, so a drift between it and where the client actually connects makes
// each of those a wrong answer.
function reportApiTarget(): void {
  const override = process.env[config.worker.freestyleApiUrlEnv]?.trim();
  console.log(`api target: ${provider.apiTarget}`);
  console.log(`sdk default: ${DEFAULT_BASE_URL}`);
  if (override) {
    console.log(`override: ${config.worker.freestyleApiUrlEnv}=${override}`);
    return;
  }
  const sdkHost = new URL(DEFAULT_BASE_URL).host;
  if (provider.apiTarget !== sdkHost) {
    console.log(
      `WARNING: apiTarget reports ${provider.apiTarget}, but with no override the client connects to ${sdkHost}`,
    );
  }
}

function vmCreateOptions(): Record<string, unknown> {
  const createOptions: Record<string, unknown> = {
    name: `jardinero-smoke-${Date.now()}`,
    cpuCores: 1,
    memoryMb: 2048,
    // The provider turns this into a TTL five minutes longer, which is what
    // reclaims the VM when this script dies before reaching its own delete.
    maxDurationMs: 10 * 60_000,
    env: { JARDINERO_SMOKE_RUN_ID: randomUUID() },
    metadata: { purpose: 'freestyle-smoke', ...githubRunMetadata() },
  };
  const image = resolveWorkerImage(config, undefined);
  if (image) createOptions.image = image;
  return createOptions;
}

// Two keys rather than one run URL: the provider truncates every metadata value
// to 63 characters, which lands mid-path on a URL and drops the run id.
function githubRunMetadata(): Record<string, string> {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!repository || !runId) return {};
  return { github_repository: repository, github_run_id: runId };
}

// `prepareWorkerUser` needs root to add the user, own the workspace and install
// sudoers. Reading each result back is what tells a provider that ran it as
// someone else apart from a failure anywhere else in create.
async function checkProvisioning(target: SandboxSession): Promise<void> {
  const probes: Probe[] = [
    { label: 'session runs as the worker user', command: 'id -un', want: WORKER_USER },
    {
      label: 'worker home ownership',
      command: `stat -c '%U:%G' ${shellQuote(WORKER_HOME)}`,
      want: `${WORKER_USER}:${WORKER_USER}`,
    },
    {
      label: 'workspace ownership',
      command: `stat -c '%U:%G' ${shellQuote(workspacePath)}`,
      want: `${WORKER_USER}:${WORKER_USER}`,
    },
    // Codex auth forwarding shells out to sudo. What the rule is written into is
    // this repository's own business, so only the capability is asserted.
    { label: 'passwordless sudo', command: 'sudo -n id -un', want: 'root' },
  ];

  for (const probe of probes) {
    const got = (await runShell(target, probe.command)).trim();
    if (got !== probe.want) {
      throw new Error(
        `${probe.label}: expected ${JSON.stringify(probe.want)}, got ${JSON.stringify(got)}`,
      );
    }
    console.log(`ok  ${probe.label}: ${got}`);
  }
}

// Every write path hands ownership to the worker in a separate root exec, so
// each is checked for the ownership it claims to leave behind.
async function checkFileApi(target: SandboxSession): Promise<void> {
  const stamp = new Date().toISOString();

  const filePath = remoteJoin(workspacePath, 'jardinero-smoke.txt');
  const fileValue = `jardinero freestyle smoke ${stamp}\n`;
  await target.writeFile(filePath, fileValue);
  await expectContent(target, filePath, fileValue, 'writeFile');
  await expectWorkerOwned(target, filePath, 'writeFile');

  const dirPath = remoteJoin(workspacePath, 'jardinero-smoke-dir');
  await target.fs.mkdir(dirPath);
  await expectWorkerOwned(target, dirPath, 'fs.mkdir');

  const streamPath = remoteJoin(dirPath, 'streamed.txt');
  const streamValue = `jardinero freestyle stream ${stamp}\n`;
  await target.fs.writeStream(streamPath, byteStream(streamValue), { mode: 0o644 });
  await expectWorkerOwned(target, streamPath, 'fs.writeStream');
  const streamed = await new Response(await target.fs.readStream(streamPath)).text();
  if (streamed !== streamValue) {
    throw new Error(
      `fs.readStream mismatch: expected ${JSON.stringify(streamValue)}, got ${JSON.stringify(streamed)}`,
    );
  }
  console.log('ok  fs.writeStream and fs.readStream round trip');
}

// A run reads nothing but the exit code to decide an agent failed, so the short
// path is checked for a status that survives the provider's own translation.
async function checkExec(target: SandboxSession): Promise<void> {
  const succeeded = await exec(target, 'printf hello && printf oops >&2');
  if (succeeded.exitCode !== 0) {
    throw new Error(`exec exit code: expected 0, got ${succeeded.exitCode}`);
  }
  if (execStdout(succeeded) !== 'hello') {
    throw new Error(`exec stdout: got ${JSON.stringify(execStdout(succeeded))}`);
  }
  if (execStderr(succeeded) !== 'oops') {
    throw new Error(`exec stderr: got ${JSON.stringify(execStderr(succeeded))}`);
  }
  console.log('ok  exec separates stdout from stderr');

  const failed = await exec(target, 'exit 7');
  if (failed.exitCode !== 7) {
    throw new Error(`exec exit code: expected 7, got ${failed.exitCode}`);
  }
  console.log('ok  exec propagates a non-zero exit code');
}

// The PTY path writes its script through two more root execs before opening the
// terminal, so it breaks on the same provisioning regression create does.
async function checkPty(target: SandboxSession): Promise<void> {
  const chunks: string[] = [];
  // execLong signals completion with an empty final chunk, so counting that one
  // would make the guard below pass on a PTY that streamed nothing.
  const result = await exec(target, "id -un && printf 'pty-marker\\n'", (text) => {
    if (text.length > 0) chunks.push(text);
  });
  if (result.exitCode !== 0) {
    throw new Error(`pty exit code: expected 0, got ${result.exitCode}`);
  }
  const text = execStdout(result);
  for (const want of [WORKER_USER, 'pty-marker']) {
    if (!text.includes(want)) {
      throw new Error(`pty output is missing ${JSON.stringify(want)}: ${JSON.stringify(text)}`);
    }
  }
  if (chunks.length === 0) {
    throw new Error('pty produced no streamed output');
  }
  console.log(`ok  pty streamed ${chunks.length} chunk(s) as ${WORKER_USER}`);
}

async function expectContent(
  target: SandboxSession,
  path: string,
  want: string,
  label: string,
): Promise<void> {
  if (!target.readFile) {
    throw new Error('readFile is unavailable on the Freestyle session');
  }
  const raw = await target.readFile(path);
  const got = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  if (got !== want) {
    throw new Error(
      `${label} readback mismatch: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
    );
  }
  console.log(`ok  ${label} readback`);
}

async function expectWorkerOwned(
  target: SandboxSession,
  path: string,
  label: string,
): Promise<void> {
  const got = (await runShell(target, `stat -c '%U:%G' ${shellQuote(path)}`)).trim();
  const want = `${WORKER_USER}:${WORKER_USER}`;
  if (got !== want) {
    throw new Error(`${label} left ${path} owned by ${got}, expected ${want}`);
  }
  console.log(`ok  ${label} ownership: ${got}`);
}

async function runShell(target: SandboxSession, command: string): Promise<string> {
  const result = await exec(target, command);
  assertExecSucceeded(result, command);
  return execStdout(result);
}

function exec(
  target: SandboxSession,
  command: string,
  onText?: (text: string) => void,
): Promise<SandboxExecResult> {
  if (!target.exec) {
    throw new Error('exec is unavailable on the Freestyle session');
  }
  return target.exec('sh', {
    args: ['-lc', command],
    ...(onText ? { onOutput: (output) => onText(new TextDecoder().decode(output.data)) } : {}),
  });
}

function byteStream(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream({
    start(stream) {
      stream.enqueue(bytes);
      stream.close();
    },
  });
}

function parseCliOptions(args: string[]): CliOptions {
  let skipPty = false;
  for (const arg of args) {
    if (arg === '--skip-pty') {
      skipPty = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { skipPty };
}

function printHelp(): void {
  console.log(`Usage: pnpm run smoke:freestyle [options]

Options:
  --skip-pty            Skip the streamed PTY check.
  -h, --help            Show this help.
`);
}

function redactedJson(value: unknown): string {
  return JSON.stringify(redact(value), null, 2);
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== 'object' || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = /token|key|secret|env/i.test(key) ? '[redacted]' : redact(nested);
  }
  return output;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
