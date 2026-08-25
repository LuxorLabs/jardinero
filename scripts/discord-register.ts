// Publishes the command table in src/adapters/discord/discord-commands.ts to one guild, so
// what the picker offers is what this build answers.
//
//   pnpm run discord:register --guild <guild id>
//
// Run once per guild, and again whenever the table changes. Guild-scoped on purpose: a
// guild registration takes effect at once, while a global one propagates on Discord's own
// schedule.

import '../src/env.js';

import { type AppConfig, configuredRepositoryNames, loadConfig } from '../src/config.js';
import { discordCommandRegistrationPayload } from '../src/adapters/discord/discord-commands.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

// Discord accepts 25 choices on an option and no more.
const MAX_OFFERED_REPOSITORIES = 25;

// The `repo` picker offers the repositories the config says we work in. One that does
// not fit is still worked on; what it loses is the dropdown, because a repository can
// also be typed into the option.
function offeredRepositories(config: AppConfig): string[] {
  const configured = configuredRepositoryNames(config);
  if (configured.length > MAX_OFFERED_REPOSITORIES) {
    const dropped = configured.slice(MAX_OFFERED_REPOSITORIES);
    console.warn(
      `Discord offers ${MAX_OFFERED_REPOSITORIES} choices at most; leaving ${dropped.length} out of the picker: ${dropped.join(', ')}`,
    );
  }
  return configured.slice(0, MAX_OFFERED_REPOSITORIES);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const offered = offeredRepositories(config);
  const guildId = argumentValue('--guild') ?? process.env.DISCORD_GUILD_ID;
  const applicationId = process.env[config.discord.applicationIdEnv];
  const botToken = process.env[config.discord.botTokenEnv];

  const missing = [
    !guildId && 'a guild id (--guild or DISCORD_GUILD_ID)',
    !applicationId && config.discord.applicationIdEnv,
    !botToken && config.discord.botTokenEnv,
  ].filter((entry): entry is string => typeof entry === 'string');
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(', ')}`);
  }

  const response = await fetch(
    `${DISCORD_API_BASE}/applications/${applicationId}/guilds/${guildId}/commands`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bot ${botToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(discordCommandRegistrationPayload(offered)),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Discord rejected the registration: ${response.status} ${text}`);
  }

  const registered = JSON.parse(text) as Array<{ name?: unknown }>;
  for (const command of registered) {
    process.stdout.write(`registered /${String(command.name)}\n`);
  }
}

function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

await main();
