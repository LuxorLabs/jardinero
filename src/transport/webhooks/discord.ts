import type { DiscordCommandOutcome } from '../../adapters/discord/discord-delivery.js';
import {
  hasAllowedDiscordRole,
  readDiscordInteraction,
} from '../../adapters/discord/discord-interaction.js';
import type { DiscordCommandInvocation } from '../../adapters/discord/discord-interaction.js';
import type { AppConfig } from '../../config.js';
import { parseJsonObject } from '../../platform/json.js';
import { nowMs } from '../../platform/time.js';
import type { Store } from '../../store/store.js';
import { type RawRequest, headerValue } from '../request.js';
import type { HandlerResponse } from '../respond.js';
import { isFreshDiscordInteractionTimestamp, verifyDiscordSignature } from './discord-signature.js';

// Discord's interaction response types, and the flag that keeps a reply private to whoever
// ran the command.
const RESPONSE_PONG = 1;
const RESPONSE_MESSAGE = 4;
const RESPONSE_DEFERRED_MESSAGE = 5;
const RESPONSE_EPHEMERAL_FLAG = 64;

export interface DiscordWebhookContext {
  config: AppConfig;
  store: Store;
  deliver(invocation: DiscordCommandInvocation): Promise<DiscordCommandOutcome>;
  env?: NodeJS.ProcessEnv;
  notifyChanged(): void;
}

// DISCORD_DELIVERY_GUARD_TTL_MS matches the tolerance of the signed-timestamp guard: an
// interaction older than that is refused anyway, so nothing beyond it can arrive twice.
const DISCORD_DELIVERY_GUARD_TTL_MS = 300_000;

// discordWebhookResponse verifies the interaction and hands the command on. Same contract
// as the GitHub and Linear receivers, with two differences that come from Discord: the
// signature is Ed25519 over timestamp and body, and the answer is this HTTP response
// rather than a later call, which is why the work is acknowledged before it is done.
export async function discordWebhookResponse(
  context: DiscordWebhookContext,
  request: RawRequest,
): Promise<HandlerResponse> {
  if (!context.config.discord.enabled) return { status: 404, body: { error: 'not_found' } };

  const publicKey = (context.env ?? process.env)[context.config.discord.publicKeyEnv];
  const signature = headerValue(request.headers['x-signature-ed25519']) ?? null;
  const timestamp = headerValue(request.headers['x-signature-timestamp']) ?? null;
  if (!verifyDiscordSignature(publicKey, request.body, signature, timestamp)) {
    return { status: 401, body: { error: 'invalid_signature' } };
  }
  if (!isFreshDiscordInteractionTimestamp(timestamp, nowMs())) {
    return { status: 401, body: { error: 'stale_timestamp' } };
  }

  let payload: Record<string, unknown>;
  try {
    payload = parseJsonObject(request.body.toString('utf8'));
  } catch {
    return { status: 400, body: { error: 'invalid_json_body' } };
  }

  const reading = readDiscordInteraction(payload);
  if (reading.isPing) return { status: 200, body: { type: RESPONSE_PONG } };
  const invocation = reading.invocation;
  if (!invocation)
    return respondEphemerally('Not a command Jardinero knows, or it arrived incomplete.');

  if (!hasAllowedDiscordRole(invocation, context.config.discord.allowedRoleIds)) {
    return respondEphemerally(
      'Your Discord roles do not allow using Jardinero; an operator has to allow one of them.',
    );
  }

  // One interaction is one command, however many times it arrives.
  const first = context.store.recordWebhookDelivery(
    'discord',
    invocation.interactionId,
    DISCORD_DELIVERY_GUARD_TTL_MS,
    request.body.toString('utf8'),
  );
  if (!first) {
    return {
      status: 200,
      body: { type: RESPONSE_DEFERRED_MESSAGE, data: { flags: RESPONSE_EPHEMERAL_FLAG } },
    };
  }

  // Deliberately not awaited: the acknowledgement has a three-second budget and the work
  // behind it does not. What happens is reported by editing this reply, so a failure with
  // nobody left to return it to is recorded here.
  void context.deliver(invocation).catch((error: unknown) => {
    context.store.appendEvent({
      eventType: 'orchestrator.discord_command_failed',
      metadata: {
        interaction_id: invocation.interactionId,
        command_name: invocation.definition.name,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  });
  context.notifyChanged();
  return {
    status: 200,
    body: { type: RESPONSE_DEFERRED_MESSAGE, data: { flags: RESPONSE_EPHEMERAL_FLAG } },
  };
}

// Ephemeral is Discord's word for a reply only the person who ran the command sees, which
// is what keeps a refusal out of a busy channel.
function respondEphemerally(content: string): HandlerResponse {
  return {
    status: 200,
    body: {
      type: RESPONSE_MESSAGE,
      data: { content, flags: RESPONSE_EPHEMERAL_FLAG, allowed_mentions: { parse: [] } },
    },
  };
}
