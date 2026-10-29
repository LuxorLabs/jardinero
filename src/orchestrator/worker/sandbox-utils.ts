import type { SandboxExecResult } from '../../types.js';

export function assertExecSucceeded(result: SandboxExecResult, label: string): void {
  if (result.exitCode === 0) return;

  const detail = redactSensitiveText(execStderr(result) || execStdout(result));
  const suffix = detail.trim() ? `: ${detail.trim().slice(0, 500)}` : '';
  throw new Error(`${label} failed with exit code ${result.exitCode}${suffix}`);
}

export const REDACTED = '[*****]';

// Shorter values are skipped because they can match ordinary text by chance.
const MIN_SECRET_LENGTH = 8;

// redactSensitiveText replaces each GitHub token in full, including the `.<payload>.<signature>`
// tail of an installation token: its `ghs_<id>_<header>` prefix is predictable.
export function redactSensitiveText(value: string): string {
  return value
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, REDACTED)
    .replace(/\bgh[opsru]_[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g, REDACTED);
}

// secretRedactor masks each given secret by its value, on top of the GitHub tokens
// redactSensitiveText already masks.
export function secretRedactor(secrets: Array<string | undefined>): (text: string) => string {
  // Output is masked one line at a time, so each line of a multi-line secret is masked too.
  const lines = secrets.flatMap((secret = '') => [secret, ...secret.split('\n')]);
  // Longest first, so a secret that contains another is masked whole.
  const values = [...new Set(lines.map((line) => line.trim()))]
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  return (text) =>
    redactSensitiveText(
      values.reduce((masked, secret) => masked.replaceAll(secret, REDACTED), text),
    );
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
