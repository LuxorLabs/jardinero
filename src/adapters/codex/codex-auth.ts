import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { assertExecSucceeded, shellQuote } from '../../orchestrator/worker/sandbox-utils.js';
import { iso, nowMs } from '../../platform/time.js';
import type { SandboxExecResult, SandboxSession } from '../../types.js';

const HOST_CODEX_AUTH_PATH = path.join(homedir(), '.codex', 'auth.json');
const REMOTE_CODEX_AUTH_DIR = '/home/tenki/.codex';
const REMOTE_CODEX_AUTH_PATH = `${REMOTE_CODEX_AUTH_DIR}/auth.json`;
const REMOTE_CODEX_CREDENTIALS_PATH = `${REMOTE_CODEX_AUTH_DIR}/.credentials.json`;
const MAX_AUTH_JSON_BYTES = 65_536;

interface HostCodexFileSnapshot {
  contents: string;
  hash: string;
  size: number;
  mtimeMs: number;
}

let hostCodexAuthCache: HostCodexFileSnapshot | null = null;
const pushedRemoteAuthHashes = new Map<string, string>();

export function hostCodexAuthPath(): string {
  return HOST_CODEX_AUTH_PATH;
}

export function hostCodexAuthExists(): boolean {
  try {
    const stat = statSync(HOST_CODEX_AUTH_PATH);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export function resetCodexAuthCacheForTest(): void {
  hostCodexAuthCache = null;
  pushedRemoteAuthHashes.clear();
}

export async function forwardHostCodexAuthToSandbox(
  session: SandboxSession,
  force = false,
): Promise<void> {
  const authSnapshot = readHostCodexAuth();
  if (!authSnapshot) {
    throw new Error(
      `Codex capsule auth requires ${HOST_CODEX_AUTH_PATH}. Run "codex login" on the orchestrator host first.`,
    );
  }
  if (!force && pushedRemoteAuthHashes.get(session.id) === authSnapshot.hash) return;
  const sandboxAuth = sandboxCodexAuth(authSnapshot.contents);

  await ensureRemoteDirectory(session, REMOTE_CODEX_AUTH_DIR);
  await session.fs.writeStream(REMOTE_CODEX_AUTH_PATH, stringToReadableStream(sandboxAuth), {
    mode: 0o600,
    truncate: true,
    sync: true,
  });

  // The host's MCP logins never reach a run, and a reused sandbox may still hold them.
  const result = await execShell(
    session,
    `sudo rm -f ${shellQuote(REMOTE_CODEX_CREDENTIALS_PATH)} && sudo chown tenki:tenki ${shellQuote(
      REMOTE_CODEX_AUTH_DIR,
    )} ${shellQuote(REMOTE_CODEX_AUTH_PATH)} && sudo chmod 700 ${shellQuote(
      REMOTE_CODEX_AUTH_DIR,
    )} && sudo chmod 600 ${shellQuote(REMOTE_CODEX_AUTH_PATH)}`,
  );
  assertExecSucceeded(result, 'install Codex auth');
  pushedRemoteAuthHashes.set(session.id, authSnapshot.hash);
}

// sandboxCodexAuth keeps the refresh_token field, which Codex requires, but empty, so a run cannot
// refresh or revoke the orchestrator's login, and dates last_refresh now to stop refreshes on age.
function sandboxCodexAuth(contents: string): string {
  let auth: unknown;
  try {
    auth = JSON.parse(contents);
  } catch {
    throw new Error(
      `${HOST_CODEX_AUTH_PATH} is not valid JSON; refusing to forward it to the sandbox.`,
    );
  }
  if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) {
    throw new Error(
      `${HOST_CODEX_AUTH_PATH} is not a JSON object; refusing to forward it to the sandbox.`,
    );
  }
  const { tokens } = auth as { tokens?: unknown };
  if (typeof tokens !== 'object' || tokens === null || !('refresh_token' in tokens)) {
    return contents;
  }
  const sandboxAuth = {
    ...auth,
    tokens: { ...tokens, refresh_token: '' },
    last_refresh: iso(nowMs()),
  };
  return `${JSON.stringify(sandboxAuth, null, 2)}\n`;
}

function readHostCodexAuth(): HostCodexFileSnapshot | null {
  hostCodexAuthCache = readHostCodexFile(
    HOST_CODEX_AUTH_PATH,
    MAX_AUTH_JSON_BYTES,
    hostCodexAuthCache,
  );
  return hostCodexAuthCache;
}

function readHostCodexFile(
  filePath: string,
  maxBytes: number,
  cache: HostCodexFileSnapshot | null,
): HostCodexFileSnapshot | null {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) {
      throw new Error(
        `${filePath} is unexpectedly large (${stat.size} bytes); refusing to forward it to the sandbox.`,
      );
    }
    const mtimeMs = typeof stat.mtimeMs === 'number' ? stat.mtimeMs : 0;
    if (cache?.size === stat.size && cache.mtimeMs === mtimeMs) {
      return cache;
    }
    const contents = readFileSync(filePath, 'utf8');
    return {
      contents,
      hash: createHash('sha256').update(contents, 'utf8').digest('hex'),
      size: stat.size,
      mtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureRemoteDirectory(session: SandboxSession, remotePath: string): Promise<void> {
  try {
    await session.fs.mkdir(remotePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/exist|already/i.test(message)) throw error;
  }
}

function stringToReadableStream(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function execShell(session: SandboxSession, command: string): Promise<SandboxExecResult> {
  if (!session.exec) {
    throw new Error(
      'Sandbox session does not expose exec; Codex auth forwarding requires shell execution.',
    );
  }
  return session.exec('sh', { args: ['-lc', command] });
}
