// Thin fetch helpers over the dashboard API. All requests are same-origin, and the
// browser is authenticated by the proxy in front before it reaches Jardinero.

/** GET JSON from the dashboard API. */
export async function getJson<T>(
  url: string,
  opts: { errorMessage: string },
): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(opts.errorMessage);
  return (await response.json()) as T;
}

/** Plain GET; caller inspects status (used where 404 is a normal outcome). */
export function getResponse(url: string, init?: Pick<RequestInit, 'signal'>): Promise<Response> {
  return fetch(url, { credentials: 'same-origin', ...init });
}

/** POST JSON; body defaults to `{}`. Returns the raw Response. */
export function postJson(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
}

/** Parse a JSON body, tolerating empty/invalid payloads (→ `{}`). */
export async function readJsonBody<T = Record<string, unknown>>(response: Response): Promise<T> {
  return response.json().catch(() => ({}) as T);
}
