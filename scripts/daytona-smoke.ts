import '../src/env.js';

import { randomUUID } from 'node:crypto';

import { loadConfig, resolveWorkerImage } from '../src/config.js';
import { DaytonaSandboxProvider } from '../src/orchestrator/worker/daytona-worker.js';
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
  skipStreaming: boolean;
}

interface Probe {
  label: string;
  command: string;
  want: string;
}

const config = loadConfig();
const options = parseCliOptions(process.argv.slice(2));
const workspacePath = normalizeRemotePath(config.worker.workspacePath);
const provider = new DaytonaSandboxProvider(config, process.env);
const runAbort = new AbortController();
const runId = randomUUID();

let session: SandboxSession | undefined;
let completed = false;
let teardownError: unknown;

console.log(`api target: ${provider.apiTarget}`);

try {
  const createOptions = sandboxCreateOptions();
  console.log('creating Daytona sandbox');
  console.log(redactedJson(createOptions));
  session = await provider.create(createOptions, runAbort.signal);
  console.log(`sandbox created: ${session.id}`);
  await provider.waitReady(session, runAbort.signal);
  console.log('sandbox ready');

  await checkProvisioning(session);
  await checkRunEnvironment(session);
  await checkFileApi(session);
  await checkExec(session);
  if (options.skipStreaming) {
    console.log('skipping the streamed exec check');
  } else {
    await checkStreamingExec(session);
  }

  completed = true;
} finally {
  if (session) {
    console.log('deleting sandbox');
    await provider.terminate(session).catch((error: unknown) => {
      teardownError = error;
      console.error(`delete failed: ${message(error)}`);
    });
  }
}

// `terminate` is part of the provider contract this exists to check, and a
// sandbox left running bills until its TTL, so a failed teardown fails the run.
// Only reachable when the body succeeded, so its error still wins over this one.
if (teardownError) {
  throw teardownError;
}

if (completed) {
  console.log('daytona smoke ok');
  process.exit(0);
}

function sandboxCreateOptions(): Record<string, unknown> {
  const createOptions: Record<string, unknown> = {
    name: `jardinero-smoke-${Date.now()}`,
    // The provider turns this into a TTL five minutes longer, which is what
    // reclaims the sandbox when this script dies before reaching its own delete.
    maxDurationMs: 10 * 60_000,
    env: { JARDINERO_SMOKE_RUN_ID: runId },
    metadata: { purpose: 'daytona-smoke', ...githubRunMetadata() },
  };
  const image = resolveWorkerImage(config, undefined);
  if (image) createOptions.image = image;
  return createOptions;
}

// Two keys rather than one run URL: the provider truncates every label to 63
// characters, which lands mid-path on a URL and drops the run id.
function githubRunMetadata(): Record<string, string> {
  const repository = process.env.GITHUB_REPOSITORY;
  const githubRunId = process.env.GITHUB_RUN_ID;
  if (!repository || !githubRunId) return {};
  return { github_repository: repository, github_run_id: githubRunId };
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
    // The toolbox daemon runs as neither root nor the worker, so without o+x on
    // the path every file read under the home answers 403 rather than failing
    // anywhere a stack trace would name.
    {
      label: 'worker home is traversable',
      command: `stat -c '%a' ${shellQuote(WORKER_HOME)}`,
      want: '755',
    },
    {
      label: 'workspace ownership',
      command: `stat -c '%U:%G' ${shellQuote(workspacePath)}`,
      want: `${WORKER_USER}:${WORKER_USER}`,
    },
    {
      label: 'workspace is traversable',
      command: `stat -c '%a' ${shellQuote(workspacePath)}`,
      want: '755',
    },
    // Codex auth forwarding shells out to sudo. What the rule is written into is
    // this repository's own business, so only the capability is asserted.
    { label: 'passwordless sudo', command: 'sudo -n id -un', want: 'root' },
  ];

  await runProbes(target, probes);
}

// Every command runs through a sudo hop that strips the inherited environment
// and sources it back from a file, so a run's tokens reach the agent only if
// that file was installed and is readable by the worker.
async function checkRunEnvironment(target: SandboxSession): Promise<void> {
  await runProbes(target, [
    {
      label: 'create env reaches the command',
      command: 'printenv JARDINERO_SMOKE_RUN_ID',
      want: runId,
    },
    { label: 'HOME is pinned to the worker', command: 'printenv HOME', want: WORKER_HOME },
    { label: 'USER is pinned to the worker', command: 'printenv USER', want: WORKER_USER },
  ]);
}

// Uploads stage in /tmp and are moved into place by a separate root exec, so
// each write path is checked for the ownership and mode it claims to leave.
async function checkFileApi(target: SandboxSession): Promise<void> {
  const stamp = new Date().toISOString();

  const filePath = remoteJoin(workspacePath, 'jardinero-smoke.txt');
  const fileValue = `jardinero daytona smoke ${stamp}\n`;
  await target.writeFile(filePath, fileValue);
  await expectContent(target, filePath, fileValue, 'writeFile');
  await expectWorkerOwned(target, filePath, 'writeFile');
  // A staging upload arrives restrictive, and the chown alone would leave the
  // file unreadable to the daemon that has to serve the readback above.
  await expectMode(target, filePath, '644', 'writeFile');

  const dirPath = remoteJoin(workspacePath, 'jardinero-smoke-dir');
  await target.fs.mkdir(dirPath);
  await expectWorkerOwned(target, dirPath, 'fs.mkdir');

  const streamPath = remoteJoin(dirPath, 'streamed.txt');
  const streamValue = `jardinero daytona stream ${stamp}\n`;
  await target.fs.writeStream(streamPath, byteStream(streamValue), { mode: 0o644 });
  await expectWorkerOwned(target, streamPath, 'fs.writeStream');
  const streamed = await new Response(await target.fs.readStream(streamPath)).text();
  if (streamed !== streamValue) {
    throw new Error(
      `fs.readStream mismatch: expected ${JSON.stringify(streamValue)}, got ${JSON.stringify(streamed)}`,
    );
  }
  console.log('ok  fs.writeStream and fs.readStream round trip');

  // Every production caller of writeStream is installing a secret at 0o600:
  // Codex auth, Codex credentials, the Grafana MCP credentials. The daemon
  // cannot read one back, so the agent user is who has to be able to.
  const secretPath = remoteJoin(dirPath, 'secret.json');
  const secretValue = `{"jardinero-daytona-secret":"${stamp}"}\n`;
  await target.fs.writeStream(secretPath, byteStream(secretValue), { mode: 0o600 });
  await expectWorkerOwned(target, secretPath, 'fs.writeStream at 0600');
  await expectMode(target, secretPath, '600', 'fs.writeStream at 0600');
  const secretRead = await runShell(target, `cat ${shellQuote(secretPath)}`);
  if (secretRead !== secretValue) {
    throw new Error(
      `0600 readback mismatch: expected ${JSON.stringify(secretValue)}, got ${JSON.stringify(secretRead)}`,
    );
  }
  console.log('ok  the worker user can read a 0600 install');
}

// A run reads nothing but the exit code to decide an agent failed, so the short
// path is checked for a status that survives the provider's own translation.
async function checkExec(target: SandboxSession): Promise<void> {
  const succeeded = await exec(target, 'printf hello && printf oops >&2');
  if (succeeded.exitCode !== 0) {
    throw new Error(`exec exit code: expected 0, got ${succeeded.exitCode}`);
  }
  // The daemon answers with one combined stream, so what is asserted is that
  // neither half was dropped, not which field ends up carrying it.
  const combined = execStdout(succeeded) + execStderr(succeeded);
  for (const want of ['hello', 'oops']) {
    if (!combined.includes(want)) {
      throw new Error(
        `exec output is missing ${JSON.stringify(want)}: ${JSON.stringify(combined)}`,
      );
    }
  }
  console.log('ok  exec keeps both stdout and stderr');

  const failed = await exec(target, 'exit 7');
  if (failed.exitCode !== 7) {
    throw new Error(`exec exit code: expected 7, got ${failed.exitCode}`);
  }
  console.log('ok  exec propagates a non-zero exit code');
}

// Streaming runs through a whole second mechanism: a daemon session, an async
// command and a log subscription, with the status read back by polling after
// the stream closes. None of it is shared with the short path above.
async function checkStreamingExec(target: SandboxSession): Promise<void> {
  const chunks: string[] = [];
  // The provider signals completion with an empty final chunk, so counting that
  // one would make the guard below pass on a stream that carried nothing.
  const result = await exec(target, "id -un && printf 'stream-marker\\n'", (text) => {
    if (text.length > 0) chunks.push(text);
  });
  if (result.exitCode !== 0) {
    throw new Error(`streamed exec exit code: expected 0, got ${result.exitCode}`);
  }
  const text = execStdout(result) + execStderr(result);
  for (const want of [WORKER_USER, 'stream-marker']) {
    if (!text.includes(want)) {
      throw new Error(
        `streamed output is missing ${JSON.stringify(want)}: ${JSON.stringify(text)}`,
      );
    }
  }
  if (chunks.length === 0) {
    throw new Error('streamed exec produced no output');
  }
  console.log(`ok  streamed exec sent ${chunks.length} chunk(s) as ${WORKER_USER}`);

  // On this path the status is polled from the daemon after the logs close,
  // rather than returned with the response, so it is worth its own case.
  const failed = await exec(target, 'exit 7', () => undefined);
  if (failed.exitCode !== 7) {
    throw new Error(`streamed exec exit code: expected 7, got ${failed.exitCode}`);
  }
  console.log('ok  streamed exec propagates a non-zero exit code');
}

async function runProbes(target: SandboxSession, probes: Probe[]): Promise<void> {
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

async function expectContent(
  target: SandboxSession,
  path: string,
  want: string,
  label: string,
): Promise<void> {
  if (!target.readFile) {
    throw new Error('readFile is unavailable on the Daytona session');
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

async function expectMode(
  target: SandboxSession,
  path: string,
  want: string,
  label: string,
): Promise<void> {
  const got = (await runShell(target, `stat -c '%a' ${shellQuote(path)}`)).trim();
  if (got !== want) {
    throw new Error(`${label} left ${path} mode ${got}, expected ${want}`);
  }
  console.log(`ok  ${label} mode: ${got}`);
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
    throw new Error('exec is unavailable on the Daytona session');
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
  let skipStreaming = false;
  for (const arg of args) {
    if (arg === '--skip-streaming') {
      skipStreaming = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { skipStreaming };
}

function printHelp(): void {
  console.log(`Usage: pnpm run smoke:daytona [options]

Options:
  --skip-streaming      Skip the streamed exec check.
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
