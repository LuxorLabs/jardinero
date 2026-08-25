import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { DiscordCommandOutcome } from '../../adapters/discord/discord-delivery.js';
import type { DiscordCommandInvocation } from '../../adapters/discord/discord-interaction.js';
import { type AppConfig, loadConfig } from '../../config.js';
import type { Store } from '../../store/store.js';
import {
  discordCommandPayload,
  signDiscordInteraction,
  signDiscordInteractionBody,
} from '../../testing/discord.js';
import { eventually } from '../../testing/http.js';
import { type StoreFixture, createTestStore } from '../../testing/store.js';
import { type DiscordWebhookContext, discordWebhookResponse } from './discord.js';

let fixture: StoreFixture;
let store: Store;
let config: AppConfig;
let delivered: DiscordCommandInvocation[];
let deliveryError: Error | undefined;
let changedNotifications: number;

beforeEach(() => {
  fixture = createTestStore();
  store = fixture.store;
  config = loadConfig();
  config.discord.enabled = true;
  config.discord.allowedRoleIds = ['role-1'];
  delivered = [];
  deliveryError = undefined;
  changedNotifications = 0;
});

afterEach(() => {
  fixture.cleanup();
});

describe('discordWebhookResponse', () => {
  const cases: Array<{
    name: string;
    arrange?(): void;
    payload?: Record<string, unknown>;
    timestampSeconds?: number;
    corruptSignature?: boolean;
    wantStatus: number;
    wantBody: unknown;
    wantDelivered: boolean;
  }> = [
    {
      name: 'When Discord is disabled then should answer as if the route did not exist',
      arrange: () => {
        config.discord.enabled = false;
      },
      wantStatus: 404,
      wantBody: { error: 'not_found' },
      wantDelivered: false,
    },
    {
      name: 'When the signature does not verify then should return error',
      corruptSignature: true,
      wantStatus: 401,
      wantBody: { error: 'invalid_signature' },
      wantDelivered: false,
    },
    {
      name: 'When the signed timestamp is old then should return error',
      timestampSeconds: Math.floor(Date.now() / 1_000) - 3_600,
      wantStatus: 401,
      wantBody: { error: 'stale_timestamp' },
      wantDelivered: false,
    },
    {
      name: 'When Discord pings the endpoint then should pong',
      payload: { type: 1 },
      wantStatus: 200,
      wantBody: { type: 1 },
      wantDelivered: false,
    },
    {
      name: 'When the interaction is not a command this build declares then should refuse it privately',
      payload: { type: 2, id: 'interaction-1', token: 'token', data: { name: 'jardinero-deploy' } },
      wantStatus: 200,
      wantBody: {
        type: 4,
        data: {
          content: 'Not a command Jardinero knows, or it arrived incomplete.',
          flags: 64,
          allowed_mentions: { parse: [] },
        },
      },
      wantDelivered: false,
    },
    {
      name: 'When the member holds no allowlisted role then should refuse it privately',
      payload: discordCommandPayload({
        commandName: 'jardinero-ticket',
        options: [{ name: 'ticket', value: 'JAR-58' }],
        roleIds: ['role-9'],
      }),
      wantStatus: 200,
      wantBody: {
        type: 4,
        data: {
          content:
            'Your Discord roles do not allow using Jardinero; an operator has to allow one of them.',
          flags: 64,
          allowed_mentions: { parse: [] },
        },
      },
      wantDelivered: false,
    },
    {
      name: 'When the command is allowed then should acknowledge it privately and hand it on',
      wantStatus: 200,
      wantBody: { type: 5, data: { flags: 64 } },
      wantDelivered: true,
    },
    {
      // Discord re-sends what it believes went unanswered, and the command already ran.
      name: 'When the same interaction arrives twice then should acknowledge it and run nothing',
      arrange: () => {
        store.recordWebhookDelivery('discord', 'interaction-1', 60_000);
      },
      wantStatus: 200,
      wantBody: { type: 5, data: { flags: 64 } },
      wantDelivered: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      testCase.arrange?.();
      const signed = signDiscordInteraction(
        testCase.payload ?? ticketCommandPayload(),
        testCase.timestampSeconds,
      );

      const response = await discordWebhookResponse(context(signed.publicKeyHex), {
        body: Buffer.from(signed.body),
        headers: testCase.corruptSignature
          ? { ...signed.headers, 'x-signature-ed25519': 'ab'.repeat(64) }
          : signed.headers,
      });

      assert.equal(response.status, testCase.wantStatus);
      assert.deepEqual(response.body, testCase.wantBody);
      assert.equal(delivered.length, testCase.wantDelivered ? 1 : 0);
    });
  }

  // The signature covers the body, so a body Discord signed and we cannot parse is the
  // only way to reach this at all.
  test('When the signed body is not JSON then should return error', async () => {
    const signed = signDiscordInteractionBody('not-json');

    const response = await discordWebhookResponse(context(signed.publicKeyHex), {
      body: Buffer.from(signed.body),
      headers: signed.headers,
    });

    assert.deepEqual(response, { status: 400, body: { error: 'invalid_json_body' } });
  });
});

describe('Discord commands that fail after they are acknowledged', () => {
  test('When the work behind the acknowledgement throws then should record it', async () => {
    deliveryError = new Error('discord is down');
    const signed = signDiscordInteraction(ticketCommandPayload());

    await discordWebhookResponse(context(signed.publicKeyHex), {
      body: Buffer.from(signed.body),
      headers: signed.headers,
    });

    await eventually(() => {
      const recorded = store
        .listEvents({}, { limit: 20 })
        .rows.filter((event) => event.eventType === 'orchestrator.discord_command_failed');
      assert.equal(recorded.length, 1);
    });
  });
});

describe('Discord interactions and the dashboard stream', () => {
  test('When a command is handed on then should wake the dashboard', async () => {
    const signed = signDiscordInteraction(ticketCommandPayload());

    await discordWebhookResponse(context(signed.publicKeyHex), {
      body: Buffer.from(signed.body),
      headers: signed.headers,
    });

    assert.equal(changedNotifications, 1);
  });
});

function ticketCommandPayload(): Record<string, unknown> {
  return discordCommandPayload({
    commandName: 'jardinero-ticket',
    options: [{ name: 'ticket', value: 'JAR-58' }],
  });
}

function context(publicKeyHex: string): DiscordWebhookContext {
  return {
    config,
    store,
    env: { [config.discord.publicKeyEnv]: publicKeyHex },
    deliver: async (invocation): Promise<DiscordCommandOutcome> => {
      if (deliveryError) throw deliveryError;
      delivered.push(invocation);
      return { handled: true };
    },
    notifyChanged: () => {
      changedNotifications += 1;
    },
  };
}
