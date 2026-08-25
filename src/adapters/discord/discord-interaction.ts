import { type DiscordCommandDefinition, discordCommandDefinition } from './discord-commands.js';

// Discord's interaction types; only the two the bot is sent.
const INTERACTION_TYPE_PING = 1;
const INTERACTION_TYPE_APPLICATION_COMMAND = 2;

// DiscordCommandInvocation is one person running one declared command: what they asked
// for, where, and the identities the answer needs.
export interface DiscordCommandInvocation {
  definition: DiscordCommandDefinition;
  options: Record<string, string>;
  discordUserId: string;
  discordUsername: string;
  roleIds: string[];
  channelId: string;
  interactionId: string;
  interactionToken: string;
}

// DiscordInteractionReading is what the interaction turned out to be. Anything the receiver
// cannot act on comes back with the reason instead of a guess.
export interface DiscordInteractionReading {
  isPing?: true;
  invocation?: DiscordCommandInvocation;
  ignored?: string;
}

// readDiscordInteraction reads an interaction into the command it invoked. A name this
// build does not declare reads as unknown rather than as an error: it means the guild's
// registration and this build disagree, which a stale registration causes.
export function readDiscordInteraction(
  payload: Record<string, unknown>,
): DiscordInteractionReading {
  const interactionType = numberField(payload, 'type');
  // Discord sends a ping when the endpoint url is saved and periodically after, and the
  // url is not accepted at all until it is answered.
  if (interactionType === INTERACTION_TYPE_PING) return { isPing: true };
  if (interactionType !== INTERACTION_TYPE_APPLICATION_COMMAND) {
    return { ignored: 'unsupported_interaction_type' };
  }

  const data = recordField(payload, 'data');
  const definition = discordCommandDefinition(stringField(data, 'name') ?? '');
  if (!definition) return { ignored: 'unknown_command' };

  const interactionId = stringField(payload, 'id');
  const interactionToken = stringField(payload, 'token');
  const channelId = stringField(payload, 'channel_id');
  // A guild command always carries member.user; a direct message would carry `user`, and
  // the bot is not installed to be written to that way.
  const member = recordField(payload, 'member');
  const user = recordField(member, 'user');
  const discordUserId = stringField(user, 'id');
  const discordUsername = stringField(user, 'username');
  if (
    !interactionId ||
    !interactionToken ||
    !channelId ||
    !discordUserId ||
    !discordUsername ||
    !definition.options.every((option) => !option.required || optionValue(data, option.name))
  ) {
    return { ignored: 'incomplete_command' };
  }

  const invocation: DiscordCommandInvocation = {
    definition,
    options: declaredOptions(data, definition),
    discordUserId,
    discordUsername,
    roleIds: stringList(member?.roles),
    channelId,
    interactionId,
    interactionToken,
  };
  return { invocation };
}

// hasAllowedDiscordRole is the gate on every command. An empty allowlist admits nobody
// rather than everybody: these commands spend money, so a missing or mistyped role id has
// to fail closed.
export function hasAllowedDiscordRole(
  invocation: DiscordCommandInvocation,
  allowedRoleIds: string[],
): boolean {
  if (allowedRoleIds.length === 0) return false;
  return invocation.roleIds.some((roleId) => allowedRoleIds.includes(roleId));
}

// Only the options the command declares are read, so an option a stale registration still
// sends cannot reach a handler.
function declaredOptions(
  data: Record<string, unknown> | undefined,
  definition: DiscordCommandDefinition,
): Record<string, string> {
  const options: Record<string, string> = {};
  for (const option of definition.options) {
    const value = optionValue(data, option.name);
    if (value) options[option.name] = value;
  }
  return options;
}

function optionValue(data: Record<string, unknown> | undefined, name: string): string | undefined {
  const options = data?.options;
  if (!Array.isArray(options)) return undefined;
  for (const entry of options) {
    if (!isPlainObject(entry) || entry.name !== name) continue;
    const value = entry.value;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function recordField(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const field = value?.[key];
  return isPlainObject(field) ? field : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
