// Minimal Discord REST client for the bot surface: posting where a person is waiting,
// opening the thread work is followed in, answering a deferred command, and reading what was
// attached to one. Mirrors the hand-rolled fetch style of linear-api.ts; callers treat
// failures as non-fatal and audit them, so every problem here throws with enough to log.

const DISCORD_API_BASE = 'https://discord.com/api/v10';

// Discord rejects a longer thread name outright, and a name taken from what a person wrote
// has no bound of its own.
const THREAD_NAME_MAX_LENGTH = 100;
// A thread stops accepting posts once archived, and a day is the longest window every guild
// tier allows.
const THREAD_ARCHIVE_MINUTES = 1_440;
// Discord answers 429 with the seconds to wait. Retrying twice covers the per-route bucket
// refilling; past that the caller is better off recording the failure than holding the run.
const RATE_LIMITED_MAX_ATTEMPTS = 3;
// A 429 that says nothing about the wait still has to wait, because trying again at once
// would only be refused again.
const RATE_LIMITED_FALLBACK_SECONDS = 1;
// The only link we ever post is the dashboard's, and it unfurls as the Google sign-in page
// it redirects to: a card nobody can use, under every line.
const SUPPRESS_EMBEDS_FLAG = 4;
// Node's fetch has no default timeout, and an announcement nobody awaits would otherwise
// hang forever on a stalled connection.
const REQUEST_TIMEOUT_MS = 10_000;

export interface DiscordMessage {
  content: string;
  // Discord pings nobody unless the message lists who it may ping, so a mention that is
  // not listed here renders as inert text.
  mentionUserIds?: string[];
}

export interface DiscordRequestOptions {
  botToken: string;
  fetchImpl?: typeof fetch;
}

export interface PostedDiscordMessage {
  messageId: string;
  channelId: string;
}

// A thread is a channel, so the id of one goes here and posting into a thread needs no
// route of its own.
export async function postDiscordMessage(
  options: DiscordRequestOptions & { channelId: string; message: DiscordMessage },
): Promise<PostedDiscordMessage> {
  const body = await discordRequest(options, {
    method: 'POST',
    path: `/channels/${options.channelId}/messages`,
    body: messageBody(options.message),
    authorization: `Bot ${options.botToken}`,
  });
  return postedDiscordMessage(body);
}

// Discord hangs a thread off a message, which is why the work posts its opening line first
// and then opens the thread on it; that message becomes the thread's first post.
export async function startDiscordThreadFromMessage(
  options: DiscordRequestOptions & { channelId: string; messageId: string; threadName: string },
): Promise<string> {
  const body = await discordRequest(options, {
    method: 'POST',
    path: `/channels/${options.channelId}/messages/${options.messageId}/threads`,
    body: {
      name: discordThreadName(options.threadName),
      auto_archive_duration: THREAD_ARCHIVE_MINUTES,
    },
    authorization: `Bot ${options.botToken}`,
  });
  const threadId = stringField(body, 'id');
  if (!threadId) throw new Error('Discord thread create returned no thread id');
  return threadId;
}

// Replaces the "thinking..." placeholder a deferred ack leaves behind. The interaction
// token authenticates this route, so the bot token must not be sent with it.
export async function editDiscordDeferredReply(options: {
  applicationId: string;
  interactionToken: string;
  message: DiscordMessage;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  await discordRequest(options, {
    method: 'PATCH',
    path: `/webhooks/${options.applicationId}/${options.interactionToken}/messages/@original`,
    body: messageBody(options.message),
  });
}

// Discord signs an attachment's CDN url and expires it, so the bytes are read while the
// interaction is still being handled rather than when a sandbox gets around to it.
export async function downloadDiscordAttachment(options: {
  url: string;
  maxBytes: number;
  fetchImpl?: typeof fetch;
}): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(options.url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Discord attachment download failed: ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > options.maxBytes) {
    throw new Error(
      `Discord attachment is ${bytes.byteLength} bytes, over the ${options.maxBytes} allowed`,
    );
  }
  return bytes;
}

function discordThreadName(name: string): string {
  const collapsed = name.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= THREAD_NAME_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, THREAD_NAME_MAX_LENGTH - 3)}...`;
}

function messageBody(message: DiscordMessage): Record<string, unknown> {
  return {
    content: message.content,
    allowed_mentions: { parse: [], users: message.mentionUserIds ?? [] },
    flags: SUPPRESS_EMBEDS_FLAG,
  };
}

async function discordRequest(
  options: { fetchImpl?: typeof fetch },
  request: {
    method: string;
    path: string;
    body: Record<string, unknown>;
    authorization?: string;
  },
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (request.authorization) headers.authorization = request.authorization;
  const where = `Discord ${request.method} ${withoutInteractionToken(request.path)}`;

  for (let attempt = 1; ; attempt += 1) {
    const response = await fetchImpl(`${DISCORD_API_BASE}${request.path}`, {
      method: request.method,
      headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (response.status === 429 && attempt < RATE_LIMITED_MAX_ATTEMPTS) {
      await sleep(retryAfterMs(response, text));
      continue;
    }
    if (!response.ok) {
      throw new Error(`${where} failed: ${response.status} ${truncate(text)}`);
    }
    if (text.trim().length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${where} returned invalid JSON: ${truncate(text)}`);
    }
  }
}

// Discord reports the wait in seconds, in the body of the 429 and in the header. A reply
// that carries neither still waits, because retrying at once would only be refused again.
function retryAfterMs(response: Response, text: string): number {
  const header = response.headers.get('retry-after');
  const fromHeader = header === null ? undefined : Number(header);
  const seconds =
    numberField(parsedOrUndefined(text), 'retry_after') ??
    (fromHeader !== undefined && Number.isFinite(fromHeader) ? fromHeader : undefined);
  return Math.max(seconds ?? RATE_LIMITED_FALLBACK_SECONDS, 0) * 1_000;
}

function postedDiscordMessage(body: unknown): PostedDiscordMessage {
  const messageId = stringField(body, 'id');
  const channelId = stringField(body, 'channel_id');
  if (!messageId || !channelId) throw new Error('Discord message create returned no message');
  return { messageId, channelId };
}

function parsedOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isPlainObject(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isPlainObject(value)) return undefined;
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

// The interaction token is a credential for the reply route, so it never reaches a log line
// or an error message.
function withoutInteractionToken(path: string): string {
  return path.replace(/^(\/webhooks\/[^/]+\/)[^/]+/, '$1[redacted]');
}
