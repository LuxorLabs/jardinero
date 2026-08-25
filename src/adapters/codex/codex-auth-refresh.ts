// Rotates the ChatGPT/Codex auth.json before Codex itself does.
//
// Capsule mode forwards the auth.json into every worker sandbox, and OpenAI revokes
// the old refresh_token as soon as a new one is issued. Codex rotates only once the
// access_token has expired, so the first sandbox to reach that expiry rotates, takes
// the new bundle to its grave when it is destroyed, and leaves the stored one
// revoked. Refreshing well inside the token's lifetime means no sandbox ever gets
// there. Rotation revokes the refresh_token, never the access_token, so a run
// already holding the old one keeps working.

export const CODEX_TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token';

export interface RefreshCodexAuthDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  tokenEndpoint?: string;
}

// Rewrites the auth.json contents with a freshly minted bundle. Returns the file to
// write back; throws with what to do about it when the exchange cannot be trusted.
export async function refreshCodexAuth(
  contents: string,
  deps: RefreshCodexAuthDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const endpoint = deps.tokenEndpoint ?? CODEX_TOKEN_ENDPOINT;

  const auth = parseAuth(contents);
  const refreshToken = auth.tokens?.refresh_token;
  const idToken = auth.tokens?.id_token;
  if (!refreshToken || !idToken) {
    throw new Error(
      'auth.json carries no tokens.refresh_token and tokens.id_token; capsule mode needs a ChatGPT login. Run "codex login".',
    );
  }

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: oauthClientIdOf(idToken),
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'openid profile email',
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Token endpoint answered ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  }

  const minted = (await response.json()) as Partial<CodexTokens>;
  if (!minted.access_token || !minted.id_token) {
    throw new Error(
      'Token endpoint answered without access_token/id_token; the refresh_token is likely revoked. Run "codex login" and store the new auth.json.',
    );
  }
  if (minted.access_token === auth.tokens?.access_token) {
    throw new Error('Token endpoint handed back the access_token it was given; nothing rotated.');
  }

  return `${JSON.stringify(
    {
      ...auth,
      tokens: {
        ...auth.tokens,
        access_token: minted.access_token,
        id_token: minted.id_token,
        // An omitted refresh_token means the server kept the current one; writing
        // undefined over it would lock the next run out.
        refresh_token: minted.refresh_token ?? refreshToken,
      },
      last_refresh: now()
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
    },
    null,
    2,
  )}\n`;
}

// The client to refresh as is the audience of the id_token that login issued, so it
// never has to be configured.
export function oauthClientIdOf(idToken: string): string {
  const payload = idToken.split('.')[1];
  if (!payload) throw new Error('The id_token in auth.json is not a JWT.');
  let claims: { aud?: string | string[] };
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Could not decode the id_token payload in auth.json.');
  }
  const audience = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
  if (!audience) throw new Error('Could not read the OAuth client from the id_token audience.');
  return audience;
}

interface CodexTokens {
  access_token: string;
  id_token: string;
  refresh_token: string;
}

interface CodexAuth {
  tokens?: Partial<CodexTokens>;
  [key: string]: unknown;
}

function parseAuth(contents: string): CodexAuth {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('auth.json is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('auth.json is not a JSON object.');
  }
  return parsed as CodexAuth;
}
