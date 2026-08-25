import { createSign } from 'node:crypto';
import type { AppConfig } from '../../config.js';

// GitHub App authentication for the orchestrator: signs the App JWT, exchanges it
// for an installation token, and refreshes it on a timer.

const GITHUB_API = 'https://api.github.com';
const JWT_LIFETIME_SECONDS = 540; // GitHub caps App JWTs at 10 min; stay under it.
const CLOCK_SKEW_SECONDS = 60;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 1_000;

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function buildAppJwt(appId: string, privateKeyPem: string, nowSeconds: number): string {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      iat: nowSeconds - CLOCK_SKEW_SECONDS,
      exp: nowSeconds + JWT_LIFETIME_SECONDS,
      iss: appId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${base64Url(signature)}`;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

export class GitHubTokenError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'GitHubTokenError';
  }
}

// 401/403 mean the credentials are wrong and will not self-heal, so they fail the
// tick immediately; 429/5xx and network/timeout errors are transient.
export function isRetriableTokenError(error: unknown): boolean {
  if (error instanceof GitHubTokenError) {
    return error.statusCode === 429 || error.statusCode >= 500;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries transient failures a few times within the tick so a brief blip does not
// cost the whole refresh interval.
export async function fetchInstallationToken(
  jwt: string,
  installationId: string,
  fetchImpl: typeof fetch,
): Promise<InstallationToken> {
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await requestInstallationToken(jwt, installationId, fetchImpl);
    } catch (error) {
      if (attempt >= MAX_FETCH_ATTEMPTS || !isRetriableTokenError(error)) throw error;
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  // Unreachable: the loop returns or throws on every attempt.
  throw new GitHubTokenError('GitHub App installation token retries exhausted', 0);
}

async function requestInstallationToken(
  jwt: string,
  installationId: string,
  fetchImpl: typeof fetch,
): Promise<InstallationToken> {
  const response = await fetchImpl(
    `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      // Node fetch has no default timeout; without this a stalled connection
      // would hang boot (or a refresh) forever.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new GitHubTokenError(
      `GitHub App installation token request failed: ${response.status}`,
      response.status,
    );
  }
  const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof body.token !== 'string' || typeof body.expires_at !== 'string') {
    throw new GitHubTokenError(
      'GitHub App installation token response missing token/expires_at',
      response.status,
    );
  }
  return { token: body.token, expiresAt: body.expires_at };
}

interface RefresherLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface GitHubAppTokenRefresherOptions {
  config: AppConfig;
  logger: RefresherLogger;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
}

export interface GitHubAppTokenRefresher {
  stop(): void;
}

export async function refreshGitHubAppToken(opts: {
  config: AppConfig;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  nowSeconds: () => number;
}): Promise<InstallationToken> {
  const { config, env, fetchImpl, nowSeconds } = opts;
  const appId = env[config.githubApp.appIdEnv];
  const installationId = env[config.githubApp.installIdEnv];
  const privateKey = env[config.githubApp.privateKeyEnv];
  const missing = [
    !appId && config.githubApp.appIdEnv,
    !installationId && config.githubApp.installIdEnv,
    !privateKey && config.githubApp.privateKeyEnv,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`GitHub App secrets missing from environment: ${missing.join(', ')}`);
  }
  // Secret stores often flatten the PEM to a single line; restore real newlines.
  const pem = (privateKey as string).replace(/\\n/g, '\n');
  const jwt = buildAppJwt(appId as string, pem, nowSeconds());
  const token = await fetchInstallationToken(jwt, installationId as string, fetchImpl);
  // Every GitHub consumer reads this env var, so this write is what distributes the token app-wide.
  env[config.worker.githubTokenEnv] = token.token;
  return token;
}

export async function startGitHubAppTokenRefresher(
  opts: GitHubAppTokenRefresherOptions,
): Promise<GitHubAppTokenRefresher> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const { config, logger } = opts;

  await refreshGitHubAppToken({ config, env, fetchImpl, nowSeconds });
  logger.info('github app installation token minted');

  // Schedule the next refresh only after the current one settles, so a slow
  // refresh can never overlap the next and race on the shared token.
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      refreshGitHubAppToken({ config, env, fetchImpl, nowSeconds })
        .then(() => logger.info('github app installation token refreshed'))
        .catch((error: unknown) =>
          logger.error('github app installation token refresh failed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(scheduleNext);
    }, config.githubApp.tokenRefreshMin * 60_000);
    timer.unref?.();
  };
  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
