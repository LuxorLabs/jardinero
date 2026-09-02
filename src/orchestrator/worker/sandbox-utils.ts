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
