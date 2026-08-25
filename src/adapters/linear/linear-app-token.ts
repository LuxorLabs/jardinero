import type { AppConfig } from '../../config.js';

// Linear agent authentication for the orchestrator: mints an app-actor access
// token via the OAuth client_credentials grant and refreshes it on a timer.
// client_credentials tokens are app-actor tokens (they act as the agent itself,
// so they can post agent-session activities) and last ~30 days; there is no
// refresh token, so a fresh one is simply minted before the old one lapses.

const TOKEN_URL = 'https://api.linear.app/oauth/token';
// app:assignable/app:mentionable keep the token acting as the delegable agent;
// read/write cover the agent-session activity and external-link mutations.
const TOKEN_SCOPES = 'read,write,app:assignable,app:mentionable';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 1_000;

export interface LinearAppToken {
  token: string;
  expiresInSeconds: number | null;
}

export class LinearTokenError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'LinearTokenError';
  }
}

// 400/401/403 mean the client credentials or grant config are wrong and will not
// self-heal, so they fail the tick immediately; 429/5xx and network/timeout
// errors are transient.
export function isRetriableTokenError(error: unknown): boolean {
  if (error instanceof LinearTokenError) {
    return error.statusCode === 429 || error.statusCode >= 500;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries transient failures a few times within the tick so a brief blip does not
// cost the whole refresh interval.
export async function fetchClientCredentialsToken(
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch,
): Promise<LinearAppToken> {
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await requestClientCredentialsToken(clientId, clientSecret, fetchImpl);
    } catch (error) {
      if (attempt >= MAX_FETCH_ATTEMPTS || !isRetriableTokenError(error)) throw error;
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  // Unreachable: the loop returns or throws on every attempt.
  throw new LinearTokenError('Linear app token retries exhausted', 0);
}

async function requestClientCredentialsToken(
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch,
): Promise<LinearAppToken> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: TOKEN_SCOPES,
    // actor=app makes the minted token act as the agent rather than a user.
    actor: 'app',
  });
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    // Node fetch has no default timeout; without this a stalled connection would
    // hang boot (or a refresh) forever.
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new LinearTokenError(
      `Linear client_credentials token request failed: ${response.status}`,
      response.status,
    );
  }
  const parsed = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof parsed.access_token !== 'string' || !parsed.access_token) {
    throw new LinearTokenError('Linear token response missing access_token', response.status);
  }
  return {
    token: parsed.access_token,
    expiresInSeconds: typeof parsed.expires_in === 'number' ? parsed.expires_in : null,
  };
}

// Writes the minted token into config.workflows.linearImplementer.apiTokenEnv, the variable
// the coordinator and webhook receiver already read, so nothing downstream changes.
export async function refreshLinearAppToken(opts: {
  config: AppConfig;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
}): Promise<LinearAppToken> {
  const { config, env, fetchImpl } = opts;
  const linear = config.workflows.linearImplementer;
  const clientId = env[linear.clientIdEnv];
  const clientSecret = env[linear.clientSecretEnv];
  const missing = [!clientId && linear.clientIdEnv, !clientSecret && linear.clientSecretEnv].filter(
    Boolean,
  );
  if (missing.length > 0) {
    throw new Error(`Linear client credentials missing from environment: ${missing.join(', ')}`);
  }
  const minted = await fetchClientCredentialsToken(
    clientId as string,
    clientSecret as string,
    fetchImpl,
  );
  env[linear.apiTokenEnv] = minted.token;
  return minted;
}

interface RefresherLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LinearAppTokenRefresherOptions {
  config: AppConfig;
  logger: RefresherLogger;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface LinearAppTokenRefresher {
  stop(): void;
}

export async function startLinearAppTokenRefresher(
  opts: LinearAppTokenRefresherOptions,
): Promise<LinearAppTokenRefresher> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { config, logger } = opts;

  const minted = await refreshLinearAppToken({ config, env, fetchImpl });
  logger.info('linear app token minted', { expires_in_seconds: minted.expiresInSeconds });

  // Schedule the next refresh only after the current one settles, so a slow
  // refresh can never overlap the next and race on the shared token.
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      refreshLinearAppToken({ config, env, fetchImpl })
        .then(() => logger.info('linear app token refreshed'))
        .catch((error: unknown) =>
          logger.error('linear app token refresh failed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(scheduleNext);
    }, config.workflows.linearImplementer.tokenRefreshMin * 60_000);
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
