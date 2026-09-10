import type { SandboxExecResult } from '../../types.js';

export function assertExecSucceeded(result: SandboxExecResult, label: string): void {
  if (result.exitCode === 0) return;

  const detail = execStderr(result) || execStdout(result);
  const suffix = detail.trim() ? `: ${detail.trim().slice(0, 500)}` : '';
  throw new Error(`${label} failed with exit code ${result.exitCode}${suffix}`);
}

export function execStdout(result: SandboxExecResult): string {
  return new TextDecoder().decode(result.stdout);
}

export function execStderr(result: SandboxExecResult): string {
  return new TextDecoder().decode(result.stderr);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function normalizeRemotePath(value: string): string {
  const trimmed = value.trim();
  const withoutTrailing = trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
  return withoutTrailing || '/home/tenki/workspace';
}

export function remoteJoin(root: string, ...parts: string[]): string {
  const normalizedRoot = normalizeRemotePath(root);
  const suffix = parts
    .map((part) => part.trim().replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0)
    .join('/');
  if (!suffix) return normalizedRoot;
  // A normalized root of '/' must not be re-prefixed, or the join doubles the
  // leading slash into '//suffix'.
  return normalizedRoot === '/' ? `/${suffix}` : `${normalizedRoot}/${suffix}`;
}

// The agent user the prepared worker images ship, and where Codex auth is
// forwarded to; every provider lands on the same layout so one image serves each.
export const WORKER_USER = 'tenki';
export const WORKER_HOME = '/home/tenki';

// workerEnvironment pins the run's environment to the agent user's home, name
// and PATH, whatever the caller passed for them.
export function workerEnvironment(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    HOME: WORKER_HOME,
    USER: WORKER_USER,
    LOGNAME: WORKER_USER,
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  };
}

// renderShellEnvironment writes the environment as a sourceable script, dropping
// any name a shell cannot export rather than breaking the whole file.
export function renderShellEnvironment(env: Record<string, string>): string {
  return `${Object.entries(env)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
    .join('\n')}\n`;
}

// buildGitCloneCommand builds a clone that reads the token from a credential
// helper, so it never lands in the URL, the process list or .git/config.
export function buildGitCloneCommand(url: string, directory: string): string {
  const credentialHelper =
    '!f() { if [ "$1" = get ]; then echo username=x-access-token; echo "password=$GITHUB_TOKEN"; fi; }; f';
  return `git -c credential.helper=${shellQuote(credentialHelper)} clone ${shellQuote(url)} ${shellQuote(directory)}`;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Run aborted.');
}

export async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

export function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function numberOption(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
