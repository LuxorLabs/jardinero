import '../src/env.js';

import { randomUUID } from 'node:crypto';
import { loadConfig, resolveSeatModel, resolveWorkerImage } from '../src/config.js';
import { forwardHostCodexAuthToSandbox } from '../src/adapters/codex/codex-auth.js';
import { JARDINERO_SANDBOX_APP, SANDBOX_METADATA } from '../src/adapters/tenki/tenki-scope.js';
import { TenkiSandboxProvider } from '../src/orchestrator/worker/tenki-worker.js';
import {
  assertExecSucceeded,
  normalizeRemotePath,
  remoteJoin,
  shellQuote,
} from '../src/orchestrator/worker/sandbox-utils.js';
import type { SandboxExecResult, SandboxSession } from '../src/types.js';

interface CliOptions {
  skipCodex: boolean;
  skipExec: boolean;
  prompt: string;
}

const config = loadConfig();
const options = parseCliOptions(process.argv.slice(2));
const workspacePath = normalizeRemotePath(config.worker.workspacePath);
const provider = new TenkiSandboxProvider(config, process.env);
const runAbort = new AbortController();

let session: SandboxSession | undefined;
let completed = false;
let teardownError: unknown;

try {
  const createOptions = createSessionOptions();
  console.log('creating Tenki sandbox session');
  console.log(redactedJson(createOptions));
  session = await provider.create(createOptions, runAbort.signal);
  console.log(`session created: ${session.id}`);
  await provider.waitReady(session, runAbort.signal);
  console.log('session ready');

  await ensureWorkspace(session);

  const smokePath = remoteJoin(workspacePath, 'jardinero-smoke.txt');
  const smokeValue = `jardinero smoke ${new Date().toISOString()}\n`;
  await session.writeFile(smokePath, smokeValue);
  console.log(`wrote ${smokePath}`);

  if (session.readFile) {
    const readBack = await session.readFile(smokePath);
    const text = readText(readBack);
    if (text !== smokeValue) {
      throw new Error(
        `readFile mismatch: expected ${JSON.stringify(smokeValue)}, got ${JSON.stringify(text)}`,
      );
    }
    console.log('readFile verified');
  } else {
    console.log('readFile unavailable on SDK session; skipping readback check');
  }

  if (!options.skipExec) {
    const execResult = await execShell(
      session,
      `pwd && ls -la ${shellQuote(workspacePath)} | sed -n "1,40p"`,
    );
    console.log('exec completed');
    console.log(redactedJson(execResult));
  }

  if (!options.skipCodex) {
    const promptPath = remoteJoin(workspacePath, 'jardinero-codex-smoke-prompt.txt');
    await session.writeFile(promptPath, options.prompt);
    await prepareCodexAuth(session);
    const result = await execShell(session, codexSmokeCommand(promptPath));
    console.log('Codex completed');
    console.log(redactedJson(result));
  }

  completed = true;
} finally {
  if (session) {
    console.log('terminating session');
    await provider.terminate(session).catch((error: unknown) => {
      teardownError = error;
      console.error(`terminate failed: ${message(error)}`);
    });
  }
}

// `terminate` is part of the provider contract this exists to check, and a
// sandbox left running costs money until its TTL, so a failed teardown fails
// the run. Only reachable when the body succeeded, so its error still wins.
if (teardownError) {
  throw teardownError;
}

if (completed) {
  console.log('tenki smoke ok');
  process.exit(0);
}

function createSessionOptions(): Record<string, unknown> {
  const env: Record<string, string> = {
    JARDINERO_SMOKE_RUN_ID: randomUUID(),
  };
  if (config.worker.codexAuthMode === 'access_token') {
    env[config.worker.codexAccessTokenEnv] = process.env[config.worker.codexAccessTokenEnv] ?? '';
  } else if (config.worker.codexAuthMode === 'api_key') {
    env[config.worker.codexApiKeyEnv] = process.env[config.worker.codexApiKeyEnv] ?? '';
  }
  const options: Record<string, unknown> = {
    name: `jardinero-smoke-${Date.now()}`,
    cpuCores: 1,
    memoryMb: 2048,
    allowInbound: false,
    allowOutbound: true,
    maxDurationMs: 10 * 60_000,
    env,
    metadata: {
      [SANDBOX_METADATA.app]: JARDINERO_SANDBOX_APP,
      purpose: 'tenki-smoke',
      ...githubRunMetadata(),
    },
  };
  const image = resolveWorkerImage(config, undefined);
  if (image) {
    options.image = image;
  }
  return options;
}

// A smoke sandbox carries no run_id, so the reaper never reclaims one the script
// drops; naming the CI run is what lets an operator trace a stray back to it.
function githubRunMetadata(): Record<string, string> {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!server || !repo || !runId) return {};
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  return {
    github_run_url: `${server}/${repo}/actions/runs/${runId}${attempt ? `/attempts/${attempt}` : ''}`,
  };
}

function parseCliOptions(args: string[]): CliOptions {
  let skipCodex = false;
  let skipExec = false;
  let prompt = 'Reply with exactly: jardinero smoke ok';

  for (const arg of args) {
    if (arg === '--skip-codex') {
      skipCodex = true;
    } else if (arg === '--skip-exec') {
      skipExec = true;
    } else if (arg.startsWith('--prompt=')) {
      prompt = arg.slice('--prompt='.length);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { skipCodex, skipExec, prompt };
}

function printHelp(): void {
  console.log(`Usage: pnpm run smoke:tenki [options]

Options:
  --skip-codex          Create the sandbox and do file/exec checks only.
  --skip-exec           Skip shell command check.
  --prompt=<text>       Override the Codex smoke prompt.
  -h, --help            Show this help.
`);
}

function redactedJson(value: unknown): string {
  return JSON.stringify(redact(value), null, 2);
}

function redact(value: unknown): unknown {
  // Object.entries sees a Uint8Array as an object, so exec output would print as
  // one JSON field per byte; a five-line `ls` becomes hundreds of log lines.
  if (value instanceof Uint8Array) return readText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== 'object' || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/token|key|secret|provider|env/i.test(key)) {
      output[key] = '[redacted]';
    } else {
      output[key] = redact(nested);
    }
  }
  return output;
}

async function prepareCodexAuth(target: SandboxSession): Promise<void> {
  if (!target.exec) return;
  if (config.worker.codexAuthMode === 'capsule') {
    await forwardHostCodexAuthToSandbox(target);
  } else if (config.worker.codexAuthMode === 'access_token') {
    const result = await execShell(
      target,
      `printenv ${shellQuote(config.worker.codexAccessTokenEnv)} | ${shellQuote(
        config.worker.codexCommand,
      )} login --with-access-token`,
    );
    assertExecSucceeded(result, 'Codex access token login');
  } else if (config.worker.codexAuthMode === 'api_key') {
    const result = await execShell(
      target,
      `printenv ${shellQuote(config.worker.codexApiKeyEnv)} | ${shellQuote(config.worker.codexCommand)} login --with-api-key`,
    );
    assertExecSucceeded(result, 'Codex API key login');
  }
}

async function ensureWorkspace(target: SandboxSession): Promise<void> {
  const result = await execShell(target, `mkdir -p ${shellQuote(workspacePath)}`);
  assertExecSucceeded(result, 'prepare smoke workspace');
}

function codexSmokeCommand(promptPath: string): string {
  const args = [
    shellQuote(config.worker.codexCommand),
    'exec',
    '--json',
    '--color',
    'never',
    '--ephemeral',
    '--skip-git-repo-check',
    '-m',
    shellQuote(resolveSeatModel(config, undefined, 'implementation')),
    '-C',
    shellQuote(workspacePath),
  ];
  if (config.worker.codexBypassSandbox) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', 'workspace-write');
  }
  args.push('-', '<', shellQuote(promptPath));
  return args.join(' ');
}

function execShell(target: SandboxSession, command: string): Promise<SandboxExecResult> {
  if (!target.exec) {
    throw new Error('exec unavailable on SDK session');
  }
  return target.exec('sh', { args: ['-lc', command] });
}

function readText(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : new TextDecoder().decode(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
