// The one place Discord commands are declared: the registration script publishes this
// table and the interaction reader routes against it, so what a guild offers and what this
// build answers cannot drift.

// Every command carries the prefix so it does not collide with another bot in a shared
// channel, and Discord's picker groups them as the person types.
export const DISCORD_COMMAND_PREFIX = 'jardinero';

// Discord's application command option type for text, the only one Jardinero reads.
const OPTION_TYPE_STRING = 3;

// Each command names what it is about: work to write, a ticket that already exists, or a
// question about what is going on.
export type DiscordCommandAction = 'code' | 'ticket' | 'status';

export interface DiscordCommandOption {
  name: string;
  description: string;
  type: typeof OPTION_TYPE_STRING;
  required: boolean;
}

export interface DiscordCommandDefinition {
  name: string;
  action: DiscordCommandAction;
  description: string;
  options: DiscordCommandOption[];
  // Whether the command answers with a deferred ack. Anything that talks to GitHub, Linear
  // or a sandbox must defer, because Discord discards an interaction left unacknowledged
  // for three seconds; a pure read of our own state answers inside the window.
  deferred: boolean;
}

export const DISCORD_COMMANDS: DiscordCommandDefinition[] = [
  {
    name: discordCommandName('code'),
    action: 'code',
    description: 'Ask Jardinero to write something, in your own words',
    options: [
      {
        name: 'request',
        description: 'What you want done',
        type: OPTION_TYPE_STRING,
        required: true,
      },
      {
        name: 'repo',
        description: 'Repository to work on; defaults to the one this channel is mapped to',
        type: OPTION_TYPE_STRING,
        required: false,
      },
    ],
    deferred: true,
  },
  {
    name: discordCommandName('ticket'),
    action: 'ticket',
    description: 'Ask Jardinero to implement a Linear ticket that already exists',
    options: [
      {
        name: 'ticket',
        description: 'Linear identifier or url, such as JAR-58',
        type: OPTION_TYPE_STRING,
        required: true,
      },
      {
        name: 'repo',
        description: 'Repository to work on; defaults to the one this channel is mapped to',
        type: OPTION_TYPE_STRING,
        required: false,
      },
    ],
    deferred: true,
  },
  {
    name: discordCommandName('status'),
    action: 'status',
    description: 'Show what Jardinero is working on and what is waiting for a person',
    options: [
      {
        name: 'ticket',
        description: 'Linear identifier or url; defaults to the ticket of the thread you ask in',
        type: OPTION_TYPE_STRING,
        required: false,
      },
    ],
    deferred: false,
  },
];

// Every command reads as the prefix plus what it is about, so the picker groups them and
// none of them is the bare word: a command that names nothing answers nothing.
export function discordCommandName(action: DiscordCommandAction): string {
  return `${DISCORD_COMMAND_PREFIX}-${action}`;
}

export function discordCommandDefinition(name: string): DiscordCommandDefinition | undefined {
  return DISCORD_COMMANDS.find((definition) => definition.name === name);
}

// The body for Discord's bulk-overwrite endpoint. Overwrite rather than create, so a
// command dropped from the table leaves the picker instead of lingering unhandled.
export function discordCommandRegistrationPayload(repositories: string[]): unknown[] {
  const choices = repositoryChoices(repositories);
  return DISCORD_COMMANDS.map((definition) => ({
    name: definition.name,
    description: definition.description,
    options: definition.options.map((option) => ({
      name: option.name,
      description: option.description,
      type: option.type,
      required: option.required,
      ...(option.name === 'repo' && choices.length > 0 ? { choices } : {}),
    })),
  }));
}

// Discord takes 25 choices at most, and a picker that silently drops repositories is worse
// than one that offers none: past that, the option is typed by hand as it always was.
const MAX_DISCORD_CHOICES = 25;

// The repositories the picker offers: the name without the owner is what a person says, and
// the whole name is what `repo` accepts.
function repositoryChoices(repositories: string[]): Array<{ name: string; value: string }> {
  if (repositories.length > MAX_DISCORD_CHOICES) return [];
  return repositories.map((repositoryFullName) => ({
    name: repositoryFullName.slice(repositoryFullName.indexOf('/') + 1),
    value: repositoryFullName,
  }));
}
