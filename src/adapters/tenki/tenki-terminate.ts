import { spawn } from 'node:child_process';

export interface TerminateTenkiSessionOptions {
  authToken?: string;
  baseUrl?: string;
  cwd?: string;
  timeoutMs: number;
}

const TERMINATE_SCRIPT = `
const sessionId = process.argv[1];
if (!sessionId) throw new Error('Missing session id');
const options = {};
if (process.env.JARDINERO_TENKI_AUTH_TOKEN) options.authToken = process.env.JARDINERO_TENKI_AUTH_TOKEN;
if (process.env.JARDINERO_TENKI_BASE_URL) options.baseUrl = process.env.JARDINERO_TENKI_BASE_URL;
const { TenkiSandbox } = await import('@tenkicloud/sandbox');
const sandbox = new TenkiSandbox(options);
const session = await sandbox.get(sessionId);
await session.close();
`;

export function terminateTenkiSessionInChild(
  sessionId: string,
  options: TerminateTenkiSessionOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs;
  const env: NodeJS.ProcessEnv = {};
  if (options.authToken) env.JARDINERO_TENKI_AUTH_TOKEN = options.authToken;
  if (options.baseUrl) env.JARDINERO_TENKI_BASE_URL = options.baseUrl;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let stderr = '';
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', TERMINATE_SCRIPT, sessionId],
      {
        cwd: options.cwd ?? process.cwd(),
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Timed out terminating Tenki sandbox session after ${timeoutMs}ms.`));
      } else if (code === 0) {
        resolve();
      } else {
        const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : '';
        reject(
          new Error(
            `Failed to terminate Tenki sandbox session (code=${code}, signal=${signal ?? 'none'})${detail}`,
          ),
        );
      }
    });
  });
}
