import '../src/env.js';

import { randomUUID } from 'node:crypto';
import { loadConfig, resolveSeatModel, resolveWorkerImage } from '../src/config.js';
import { forwardHostCodexAuthToSandbox } from '../src/adapters/codex/codex-auth.js';
import { terminateTenkiSessionInChild } from '../src/adapters/tenki/tenki-terminate.js';
import {
  JARDINERO_SANDBOX_APP,
  resolveWorkspaceScope,
  SANDBOX_METADATA,
} from '../src/adapters/tenki/tenki-scope.js';
import {
  assertExecSucceeded,
  normalizeRemotePath,
  remoteJoin,
  shellQuote,
} from '../src/orchestrator/worker/sandbox-utils.js';

type TenkiSdk = typeof import('@tenkicloud/sandbox');
type TenkiSession = import('@tenkicloud/sandbox').Session;
type TenkiExecResult = import('@tenkicloud/sandbox').ExecResult;

interface CliOptions {
  skipCodex: boolean;
  skipExec: boolean;
  prompt: string;
}

const config = loadConfig();
const options = parseCliOptions(process.argv.slice(2));
const sdk = await loadTenkiSdk();
const workspacePath = normalizeRemotePath(config.worker.workspacePath);

const sandbox = new sdk.TenkiSandbox(sandboxOptions());
let session: TenkiSession | undefined;
let completed = false;

try {
  const createOptions = createSessionOptions();
  Object.assign(createOptions, await resolveWorkspaceScope(config, process.env, sandbox));
  console.log('creating Tenki sandbox session');
  console.log(redactedJson(createOptions));
  session = await sandbox.createAndWait(createOptions);
  console.log(`session ready: ${session.id ?? '<unknown-id>'}`);

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
    const closingSession = session;
    console.log('terminating session');
    await terminateTenkiSessionInChild(closingSession.id, {
      authToken: process.env[config.worker.tenkiApiKeyEnv],
      baseUrl: process.env[config.worker.tenkiApiUrlEnv],
      cwd: config.rootDir,
      timeoutMs: config.worker.sessionCloseTimeoutMs,
    }).catch(async (error: unknown) => {
      console.error(`terminate failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

if (completed) {
  process.exit(0);
}

async function loadTenkiSdk(): Promise<TenkiSdk> {
  try {
    return await import('@tenkicloud/sandbox');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to load @tenkicloud/sandbox (${message}). Run pnpm install to install @tenkicloud/sandbox.`,
    );
  }
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
    },
    tags: [JARDINERO_SANDBOX_APP],
  };
  const image = resolveWorkerImage(config, undefined);
  if (image) {
    options.image = image;
  }
  return options;
}

function sandboxOptions(): Record<string, string> {
  const apiKey = process.env[config.worker.tenkiApiKeyEnv];
  const options: Record<string, string> = {};
  if (apiKey) options.authToken = apiKey;
  if (process.env[config.worker.tenkiApiUrlEnv]) {
    options.baseUrl = process.env[config.worker.tenkiApiUrlEnv]!;
  }
  return options;
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

async function prepareCodexAuth(session: TenkiSession): Promise<void> {
  if (!session.exec) return;
  if (config.worker.codexAuthMode === 'capsule') {
    await forwardHostCodexAuthToSandbox(session);
  } else if (config.worker.codexAuthMode === 'access_token') {
    const result = await execShell(
      session,
      `printenv ${shellQuote(config.worker.codexAccessTokenEnv)} | ${shellQuote(
        config.worker.codexCommand,
      )} login --with-access-token`,
    );
    assertExecSucceeded(result, 'Codex access token login');
  } else if (config.worker.codexAuthMode === 'api_key') {
    const result = await execShell(
      session,
      `printenv ${shellQuote(config.worker.codexApiKeyEnv)} | ${shellQuote(config.worker.codexCommand)} login --with-api-key`,
    );
    assertExecSucceeded(result, 'Codex API key login');
  }
}

async function ensureWorkspace(session: TenkiSession): Promise<void> {
  const result = await execShell(session, `mkdir -p ${shellQuote(workspacePath)}`);
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

function execShell(session: TenkiSession, command: string): Promise<TenkiExecResult> {
  if (!session.exec) {
    throw new Error('exec unavailable on SDK session');
  }
  return session.exec('sh', { args: ['-lc', command] });
}

function readText(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : new TextDecoder().decode(value);
}
