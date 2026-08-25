import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { assertExecSucceeded, shellQuote } from '../tenki/tenki-utils.js';

type TenkiSession = import('@tenkicloud/sandbox').Session;
type TenkiExecResult = import('@tenkicloud/sandbox').ExecResult;

const HOST_CODEX_AUTH_PATH = path.join(homedir(), '.codex', 'auth.json');
const HOST_CODEX_CREDENTIALS_PATH = path.join(homedir(), '.codex', '.credentials.json');
const REMOTE_CODEX_AUTH_DIR = '/home/tenki/.codex';
const REMOTE_CODEX_AUTH_PATH = `${REMOTE_CODEX_AUTH_DIR}/auth.json`;
const REMOTE_CODEX_CREDENTIALS_PATH = `${REMOTE_CODEX_AUTH_DIR}/.credentials.json`;
const MAX_AUTH_JSON_BYTES = 65_536;
const MAX_CREDENTIALS_JSON_BYTES = 262_144;

interface HostCodexFileSnapshot {
  contents: string;
  hash: string;
  size: number;
  mtimeMs: number;
}

let hostCodexAuthCache: HostCodexFileSnapshot | null = null;
let hostCodexCredentialsCache: HostCodexFileSnapshot | null = null;
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
  hostCodexCredentialsCache = null;
  pushedRemoteAuthHashes.clear();
}

export async function forwardHostCodexAuthToSandbox(
  session: TenkiSession,
  force = false,
): Promise<void> {
  const authSnapshot = readHostCodexAuth();
  if (!authSnapshot) {
    throw new Error(
      `Codex capsule auth requires ${HOST_CODEX_AUTH_PATH}. Run "codex login" on the orchestrator host first.`,
    );
  }
  const credentialsSnapshot = readHostCodexCredentials();
  const snapshotHash = combinedSnapshotHash(authSnapshot, credentialsSnapshot);

  if (!force && pushedRemoteAuthHashes.get(session.id) === snapshotHash) return;

  await ensureRemoteDirectory(session, REMOTE_CODEX_AUTH_DIR);
  await session.fs.writeStream(
    REMOTE_CODEX_AUTH_PATH,
    stringToReadableStream(authSnapshot.contents),
    {
      mode: 0o600,
      truncate: true,
      sync: true,
    },
  );
  if (credentialsSnapshot) {
    await session.fs.writeStream(
      REMOTE_CODEX_CREDENTIALS_PATH,
      stringToReadableStream(credentialsSnapshot.contents),
      {
        mode: 0o600,
        truncate: true,
        sync: true,
      },
    );
  }

  const chownTargets = [REMOTE_CODEX_AUTH_DIR, REMOTE_CODEX_AUTH_PATH];
  const chmodTargets = [REMOTE_CODEX_AUTH_PATH];
  if (credentialsSnapshot) {
    chownTargets.push(REMOTE_CODEX_CREDENTIALS_PATH);
    chmodTargets.push(REMOTE_CODEX_CREDENTIALS_PATH);
  }

  const result = await execShell(
    session,
    `${credentialsSnapshot ? '' : `sudo rm -f ${shellQuote(REMOTE_CODEX_CREDENTIALS_PATH)} && `}sudo chown tenki:tenki ${chownTargets
      .map(shellQuote)
      .join(
        ' ',
      )} && sudo chmod 700 ${shellQuote(REMOTE_CODEX_AUTH_DIR)} && sudo chmod 600 ${chmodTargets
      .map(shellQuote)
      .join(' ')}`,
  );
  assertExecSucceeded(result, 'install Codex auth');
  pushedRemoteAuthHashes.set(session.id, snapshotHash);
}

function readHostCodexAuth(): HostCodexFileSnapshot | null {
  hostCodexAuthCache = readHostCodexFile(
    HOST_CODEX_AUTH_PATH,
    MAX_AUTH_JSON_BYTES,
    hostCodexAuthCache,
  );
  return hostCodexAuthCache;
}

function readHostCodexCredentials(): HostCodexFileSnapshot | null {
  hostCodexCredentialsCache = readHostCodexFile(
    HOST_CODEX_CREDENTIALS_PATH,
    MAX_CREDENTIALS_JSON_BYTES,
    hostCodexCredentialsCache,
  );
  return hostCodexCredentialsCache;
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

function combinedSnapshotHash(
  authSnapshot: HostCodexFileSnapshot,
  credentialsSnapshot: HostCodexFileSnapshot | null,
): string {
  return createHash('sha256')
    .update('auth:')
    .update(authSnapshot.hash)
    .update('\ncredentials:')
    .update(credentialsSnapshot?.hash ?? 'missing')
    .digest('hex');
}

async function ensureRemoteDirectory(session: TenkiSession, remotePath: string): Promise<void> {
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

function execShell(session: TenkiSession, command: string): Promise<TenkiExecResult | string> {
  if (!session.exec) {
    throw new Error(
      'Tenki session does not expose exec; Codex auth forwarding requires shell execution.',
    );
  }
  return session.exec('sh', { args: ['-lc', command] });
}
