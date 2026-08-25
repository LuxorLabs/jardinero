type TenkiExecResult = import('@tenkicloud/sandbox').ExecResult;

// Where the worker template installs Playwright's chromium. The template build
// runs as root while agents run as the tenki user, so the browsers live in a
// shared system path instead of a per-user cache.
export const PLAYWRIGHT_BROWSERS_PATH = '/usr/local/share/ms-playwright';

export function assertExecSucceeded(result: TenkiExecResult | string, label: string): void {
  const exitCode = execExitCode(result);
  if (typeof exitCode !== 'number' || exitCode === 0) return;

  const detail =
    execString(result, ['stderr', 'error']) || execString(result, ['stdout', 'output']);
  const suffix = detail.trim() ? `: ${detail.trim().slice(0, 500)}` : '';
  throw new Error(`${label} failed with exit code ${exitCode}${suffix}`);
}

export function execString(result: TenkiExecResult | string, keys: string[]): string {
  if (typeof result === 'string')
    return keys.includes('stdout') || keys.includes('output') ? result : '';
  const record = result as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  }
  return '';
}

export function execExitCode(result: TenkiExecResult | string): number | undefined {
  if (typeof result === 'string') return undefined;
  const record = result as unknown as Record<string, unknown>;
  for (const key of ['exitCode', 'code', 'status']) {
    const value = record[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
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
