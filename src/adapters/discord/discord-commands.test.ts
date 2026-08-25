import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DISCORD_COMMANDS,
  type DiscordCommandAction,
  discordCommandDefinition,
  discordCommandName,
  discordCommandRegistrationPayload,
} from './discord-commands.js';

describe('discordCommandName', () => {
  const cases: Array<{ name: string; action: DiscordCommandAction; wantName: string }> = [
    {
      name: 'When the action is `code` then should suffix the prefix with it',
      action: 'code',
      wantName: 'jardinero-code',
    },
    {
      name: 'When the action is `ticket` then should suffix the prefix with it',
      action: 'ticket',
      wantName: 'jardinero-ticket',
    },
    {
      name: 'When the action is `status` then should suffix the prefix with it',
      action: 'status',
      wantName: 'jardinero-status',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(discordCommandName(testCase.action), testCase.wantName);
    });
  }
});

describe('discordCommandDefinition', () => {
  const cases: Array<{ name: string; commandName: string; wantAction?: DiscordCommandAction }> = [
    {
      name: 'When the name is declared then should return its definition',
      commandName: 'jardinero-ticket',
      wantAction: 'ticket',
    },
    {
      name: 'When the name is not declared then should return nothing',
      commandName: 'jardinero-deploy',
      wantAction: undefined,
    },
    {
      name: 'When the name is a declared action without the prefix then should return nothing',
      commandName: 'ticket',
      wantAction: undefined,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(discordCommandDefinition(testCase.commandName)?.action, testCase.wantAction);
    });
  }
});

describe('The repositories the picker offers', () => {
  const cases: Array<{ name: string; repositories: string[]; wantChoices?: unknown }> = [
    {
      name: 'When we work in a repository then should offer it by the name a person says',
      repositories: ['acme/orchestrator', 'acme/web.app'],
      wantChoices: [
        { name: 'orchestrator', value: 'acme/orchestrator' },
        { name: 'web.app', value: 'acme/web.app' },
      ],
    },
    {
      // Discord takes 25 at most, and a picker missing repositories is worse than none.
      name: 'When we work in more than Discord offers then should leave the option free text',
      repositories: Array.from({ length: 26 }, (_, index) => `acme/repo-${index}`),
      wantChoices: undefined,
    },
    {
      name: 'When we work in no repository then should leave the option free text',
      repositories: [],
      wantChoices: undefined,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const payload = discordCommandRegistrationPayload(testCase.repositories) as Array<{
        name: string;
        options: Array<Record<string, unknown>>;
      }>;

      const repoOption = payload
        .find((command) => command.name === 'jardinero-ticket')
        ?.options.find((option) => option.name === 'repo');
      assert.deepEqual(repoOption?.choices, testCase.wantChoices);
    });
  }
});

describe('discordCommandRegistrationPayload', () => {
  test('When the table is published then should carry every declared command', () => {
    const payload = discordCommandRegistrationPayload([]) as Array<{ name: string }>;

    assert.deepEqual(
      payload.map((command) => command.name),
      DISCORD_COMMANDS.map((definition) => definition.name),
    );
  });

  test('When a command declares options then should publish each with its type and requirement', () => {
    const payload = discordCommandRegistrationPayload([]) as Array<Record<string, unknown>>;

    assert.deepEqual(
      payload.find((command) => command.name === 'jardinero-code'),
      {
        name: 'jardinero-code',
        description: 'Ask Jardinero to write something, in your own words',
        options: [
          {
            name: 'request',
            description: 'What you want done',
            type: 3,
            required: true,
          },
          {
            name: 'repo',
            description: 'Repository to work on; defaults to the one this channel is mapped to',
            type: 3,
            required: false,
          },
        ],
      },
    );
  });
});

// Discord refuses a registration that breaks any of these, and the picker is the only place
// it would show up.
describe('DISCORD_COMMANDS as Discord accepts them', () => {
  for (const definition of DISCORD_COMMANDS) {
    test(`When \`${definition.name}\` is registered then should meet Discord's limits`, () => {
      assert.match(definition.name, /^[a-z][a-z-]{0,31}$/);
      assert.ok(definition.description.length <= 100);
      const optionalIndex = definition.options.findIndex((option) => !option.required);
      const requiredAfterOptional = definition.options
        .slice(optionalIndex < 0 ? definition.options.length : optionalIndex)
        .some((option) => option.required);
      assert.equal(requiredAfterOptional, false);
      for (const option of definition.options) {
        assert.match(option.name, /^[a-z][a-z-]{0,31}$/);
        assert.ok(option.description.length <= 100);
      }
    });
  }
});
