import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { hasAllowedDiscordRole, readDiscordInteraction } from './discord-interaction.js';
import type { DiscordInteractionReading } from './discord-interaction.js';

describe('readDiscordInteraction', () => {
  const cases: Array<{
    name: string;
    mutate(payload: InteractionPayload): void;
    wantReading: DiscordInteractionReading;
  }> = [
    {
      // Discord sends this when the endpoint url is saved, and will not accept the url
      // until it is answered.
      name: 'When Discord pings the endpoint then should read it as a ping',
      mutate: (payload) => {
        payload.type = 1;
      },
      wantReading: { isPing: true },
    },
    {
      name: 'When the interaction type is one the bot is not sent then should ignore it',
      mutate: (payload) => {
        payload.type = 3;
      },
      wantReading: { ignored: 'unsupported_interaction_type' },
    },
    {
      name: 'When the interaction carries no type then should ignore it',
      mutate: (payload) => {
        delete payload.type;
      },
      wantReading: { ignored: 'unsupported_interaction_type' },
    },
    {
      name: 'When the command name is not declared then should ignore it',
      mutate: (payload) => {
        payload.data = { name: 'jardinero-deploy' };
      },
      wantReading: { ignored: 'unknown_command' },
    },
    {
      name: 'When the interaction carries no command data then should ignore it',
      mutate: (payload) => {
        delete payload.data;
      },
      wantReading: { ignored: 'unknown_command' },
    },
    {
      name: 'When the interaction id is absent then should ignore it',
      mutate: (payload) => {
        delete payload.id;
      },
      wantReading: { ignored: 'incomplete_command' },
    },
    {
      name: 'When the interaction token is absent then should ignore it',
      mutate: (payload) => {
        delete payload.token;
      },
      wantReading: { ignored: 'incomplete_command' },
    },
    {
      name: 'When the channel is absent then should ignore it',
      mutate: (payload) => {
        delete payload.channel_id;
      },
      wantReading: { ignored: 'incomplete_command' },
    },
    {
      name: 'When the command came from outside a guild then should ignore it',
      mutate: (payload) => {
        delete payload.member;
      },
      wantReading: { ignored: 'incomplete_command' },
    },
    {
      name: 'When the invoking user has no id then should ignore it',
      mutate: (payload) => {
        payload.member = { user: { username: 'octo' } };
      },
      wantReading: { ignored: 'incomplete_command' },
    },
    {
      name: 'When the invoking user has no username then should ignore it',
      mutate: (payload) => {
        payload.member = { user: { id: '1001' } };
      },
      wantReading: { ignored: 'incomplete_command' },
    },
    {
      name: 'When a required option is absent then should ignore it',
      mutate: (payload) => {
        payload.data = { name: 'jardinero-code', options: [] };
      },
      wantReading: { ignored: 'incomplete_command' },
    },
    {
      name: 'When a required option is blank then should ignore it',
      mutate: (payload) => {
        payload.data = { name: 'jardinero-code', options: [{ name: 'request', value: '   ' }] };
      },
      wantReading: { ignored: 'incomplete_command' },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const reading = readDiscordInteraction(interactionPayload(testCase.mutate));

      assert.deepEqual(reading, testCase.wantReading);
    });
  }
});

describe('Discord commands as the receiver reads them', () => {
  test('When the command is complete then should read who ran it, where, and with what', () => {
    const reading = readDiscordInteraction(interactionPayload());

    assert.equal(reading.invocation?.definition.action, 'code');
    assert.deepEqual(reading.invocation?.options, { request: 'fix the typo' });
    assert.equal(reading.invocation?.discordUserId, '1001');
    assert.equal(reading.invocation?.discordUsername, 'octo');
    assert.deepEqual(reading.invocation?.roleIds, ['role-1']);
    assert.equal(reading.invocation?.channelId, 'channel-1');
    assert.equal(reading.invocation?.interactionId, 'interaction-1');
    assert.equal(reading.invocation?.interactionToken, 'interaction-token');
  });

  test('When an option is padded then should read it trimmed', () => {
    const reading = readDiscordInteraction(
      interactionPayload((payload) => {
        payload.data = {
          name: 'jardinero-code',
          options: [{ name: 'request', value: ' the typo ' }],
        };
      }),
    );

    assert.deepEqual(reading.invocation?.options, { request: 'the typo' });
  });

  test('When the interaction carries an option the command never declared then should drop it', () => {
    const reading = readDiscordInteraction(
      interactionPayload((payload) => {
        payload.data = {
          name: 'jardinero-code',
          options: [
            { name: 'request', value: 'fix the typo' },
            { name: 'preview', value: 'true' },
          ],
        };
      }),
    );

    assert.deepEqual(reading.invocation?.options, { request: 'fix the typo' });
  });

  test('When the member carries no roles then should read none', () => {
    const reading = readDiscordInteraction(
      interactionPayload((payload) => {
        payload.member = { user: { id: '1001', username: 'octo' } };
      }),
    );

    assert.deepEqual(reading.invocation?.roleIds, []);
  });
});

describe('hasAllowedDiscordRole', () => {
  const cases: Array<{
    name: string;
    roleIds: string[];
    allowedRoleIds: string[];
    wantAllowed: boolean;
  }> = [
    {
      name: 'When no role is allowlisted then should admit nobody',
      roleIds: ['role-1'],
      allowedRoleIds: [],
      wantAllowed: false,
    },
    {
      name: 'When the member holds an allowlisted role then should admit them',
      roleIds: ['role-9', 'role-1'],
      allowedRoleIds: ['role-1'],
      wantAllowed: true,
    },
    {
      name: 'When the member holds no allowlisted role then should refuse them',
      roleIds: ['role-9'],
      allowedRoleIds: ['role-1'],
      wantAllowed: false,
    },
    {
      name: 'When the member holds no role at all then should refuse them',
      roleIds: [],
      allowedRoleIds: ['role-1'],
      wantAllowed: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const reading = readDiscordInteraction(
        interactionPayload((payload) => {
          payload.member = { user: { id: '1001', username: 'octo' }, roles: testCase.roleIds };
        }),
      );
      assert.ok(reading.invocation);

      assert.equal(
        hasAllowedDiscordRole(reading.invocation, testCase.allowedRoleIds),
        testCase.wantAllowed,
      );
    });
  }
});

interface InteractionPayload {
  type?: unknown;
  id?: string;
  token?: string;
  channel_id?: string;
  member?: { user?: { id?: string; username?: string }; roles?: unknown };
  data?: {
    name?: string;
    options?: Array<{ name: string; value: unknown }>;
    resolved?: { attachments?: Record<string, unknown> };
  };
}

function interactionPayload(
  mutate: (payload: InteractionPayload) => void = () => {},
): Record<string, unknown> {
  const payload: InteractionPayload = {
    type: 2,
    id: 'interaction-1',
    token: 'interaction-token',
    channel_id: 'channel-1',
    member: { user: { id: '1001', username: 'octo' }, roles: ['role-1'] },
    data: { name: 'jardinero-code', options: [{ name: 'request', value: 'fix the typo' }] },
  };
  mutate(payload);
  return payload as Record<string, unknown>;
}
