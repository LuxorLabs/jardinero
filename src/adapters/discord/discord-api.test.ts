import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  downloadDiscordAttachment,
  editDiscordDeferredReply,
  postDiscordMessage,
  startDiscordThreadFromMessage,
} from './discord-api.js';

describe('postDiscordMessage', () => {
  test('When the message is posted then should authenticate as the bot and answer where it landed', async () => {
    const discord = fakeDiscord([jsonResponse(200, { id: 'message-1', channel_id: 'channel-1' })]);

    const posted = await postDiscordMessage({
      botToken: 'bot-token',
      fetchImpl: discord.fetchImpl,
      channelId: 'channel-1',
      message: { content: 'the pull request is ready' },
    });

    assert.deepEqual(posted, { messageId: 'message-1', channelId: 'channel-1' });
    assert.equal(discord.calls[0]?.url, 'https://discord.com/api/v10/channels/channel-1/messages');
    assert.equal(discord.calls[0]?.method, 'POST');
    assert.equal(discord.calls[0]?.authorization, 'Bot bot-token');
  });

  test('When the message names who it may ping then should allow only those mentions', async () => {
    const discord = fakeDiscord([jsonResponse(200, { id: 'message-1', channel_id: 'channel-1' })]);

    await postDiscordMessage({
      botToken: 'bot-token',
      fetchImpl: discord.fetchImpl,
      channelId: 'channel-1',
      message: { content: '<@1001> the pull request is ready', mentionUserIds: ['1001'] },
    });

    assert.deepEqual(discord.calls[0]?.body, {
      content: '<@1001> the pull request is ready',
      allowed_mentions: { parse: [], users: ['1001'] },
      flags: 4,
    });
  });

  test('When the message carries no mentions then should suppress every ping', async () => {
    const discord = fakeDiscord([jsonResponse(200, { id: 'message-1', channel_id: 'channel-1' })]);

    await postDiscordMessage({
      botToken: 'bot-token',
      fetchImpl: discord.fetchImpl,
      channelId: 'channel-1',
      message: { content: 'the pull request is ready' },
    });

    assert.deepEqual(discord.calls[0]?.body, {
      content: 'the pull request is ready',
      allowed_mentions: { parse: [], users: [] },
      flags: 4,
    });
  });

  const rejections: Array<{ name: string; body: unknown }> = [
    { name: 'carries no message id', body: { channel_id: 'channel-1' } },
    { name: 'carries no channel id', body: { id: 'message-1' } },
  ];

  for (const rejection of rejections) {
    test(`When the reply ${rejection.name} then should return error`, async () => {
      const discord = fakeDiscord([jsonResponse(200, rejection.body)]);

      await assert.rejects(
        postDiscordMessage({
          botToken: 'bot-token',
          fetchImpl: discord.fetchImpl,
          channelId: 'channel-1',
          message: { content: 'the pull request is ready' },
        }),
        /returned no message/,
      );
    });
  }
});

describe('startDiscordThreadFromMessage', () => {
  test('When the thread is opened then should hang it off the message and answer its id', async () => {
    const discord = fakeDiscord([jsonResponse(201, { id: 'thread-1' })]);

    const threadId = await startDiscordThreadFromMessage({
      botToken: 'bot-token',
      fetchImpl: discord.fetchImpl,
      channelId: 'channel-1',
      messageId: 'message-1',
      threadName: 'fix the typo',
    });

    assert.equal(threadId, 'thread-1');
    assert.equal(
      discord.calls[0]?.url,
      'https://discord.com/api/v10/channels/channel-1/messages/message-1/threads',
    );
    assert.deepEqual(discord.calls[0]?.body, {
      name: 'fix the typo',
      auto_archive_duration: 1_440,
    });
  });

  test('When the reply carries no thread id then should return error', async () => {
    const discord = fakeDiscord([jsonResponse(201, { name: 'fix the typo' })]);

    await assert.rejects(
      startDiscordThreadFromMessage({
        botToken: 'bot-token',
        fetchImpl: discord.fetchImpl,
        channelId: 'channel-1',
        messageId: 'message-1',
        threadName: 'fix the typo',
      }),
      /returned no thread id/,
    );
  });
});

describe('editDiscordDeferredReply', () => {
  test('When the deferred reply is answered then should edit the original with the interaction token alone', async () => {
    const discord = fakeDiscord([emptyResponse(200)]);

    await editDiscordDeferredReply({
      applicationId: 'application-1',
      interactionToken: 'interaction-token',
      message: { content: 'working on JAR-58' },
      fetchImpl: discord.fetchImpl,
    });

    assert.equal(
      discord.calls[0]?.url,
      'https://discord.com/api/v10/webhooks/application-1/interaction-token/messages/@original',
    );
    assert.equal(discord.calls[0]?.method, 'PATCH');
    assert.equal(discord.calls[0]?.authorization, undefined);
  });

  test('When Discord refuses the edit then should report it without the interaction token', async () => {
    const discord = fakeDiscord([jsonResponse(404, { message: 'Unknown Webhook' })]);

    await assert.rejects(
      editDiscordDeferredReply({
        applicationId: 'application-1',
        interactionToken: 'interaction-token',
        message: { content: 'working on JAR-58' },
        fetchImpl: discord.fetchImpl,
      }),
      (error: Error) => {
        assert.match(error.message, /\/webhooks\/application-1\/\[redacted\]/);
        assert.equal(error.message.includes('interaction-token'), false);
        return true;
      },
    );
  });
});

describe('downloadDiscordAttachment', () => {
  test('When the attachment is readable then should answer its bytes', async () => {
    const discord = fakeDiscord([new Response(Buffer.from('the file'), { status: 200 })]);

    const bytes = await downloadDiscordAttachment({
      url: 'https://cdn.discordapp.test/compare.png',
      maxBytes: 1_024,
      fetchImpl: discord.fetchImpl,
    });

    assert.equal(bytes.toString('utf8'), 'the file');
  });

  test('When the signed url no longer resolves then should return error', async () => {
    const discord = fakeDiscord([emptyResponse(403)]);

    await assert.rejects(
      downloadDiscordAttachment({
        url: 'https://cdn.discordapp.test/compare.png',
        maxBytes: 1_024,
        fetchImpl: discord.fetchImpl,
      }),
      /download failed: 403/,
    );
  });

  test('When the attachment is over the size allowed then should return error', async () => {
    const discord = fakeDiscord([new Response(Buffer.from('the file'), { status: 200 })]);

    await assert.rejects(
      downloadDiscordAttachment({
        url: 'https://cdn.discordapp.test/compare.png',
        maxBytes: 4,
        fetchImpl: discord.fetchImpl,
      }),
      /over the 4 allowed/,
    );
  });
});

describe('Discord thread names', () => {
  const cases: Array<{ name: string; threadName: string; wantName: string }> = [
    {
      name: 'When the name fits then should keep it',
      threadName: 'fix the typo',
      wantName: 'fix the typo',
    },
    {
      name: 'When the name is written across lines then should collapse it to one',
      threadName: 'fix\n  the   typo ',
      wantName: 'fix the typo',
    },
    {
      name: 'When the name is longer than Discord accepts then should clip it',
      threadName: 'x'.repeat(120),
      wantName: `${'x'.repeat(97)}...`,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const discord = fakeDiscord([jsonResponse(201, { id: 'thread-1' })]);

      await startDiscordThreadFromMessage({
        botToken: 'bot-token',
        fetchImpl: discord.fetchImpl,
        channelId: 'channel-1',
        messageId: 'message-1',
        threadName: testCase.threadName,
      });

      assert.equal((discord.calls[0]?.body as { name: string }).name, testCase.wantName);
    });
  }
});

describe('Discord requests under a rate limit', () => {
  test('When Discord answers 429 then should wait the seconds it asks for and try again', async () => {
    const discord = fakeDiscord([
      jsonResponse(429, { retry_after: 0 }),
      jsonResponse(200, { id: 'message-1', channel_id: 'channel-1' }),
    ]);

    const posted = await postDiscordMessage({
      botToken: 'bot-token',
      fetchImpl: discord.fetchImpl,
      channelId: 'channel-1',
      message: { content: 'the pull request is ready' },
    });

    assert.equal(posted.messageId, 'message-1');
    assert.equal(discord.calls.length, 2);
  });

  test('When Discord keeps answering 429 then should stop trying and return error', async () => {
    const discord = fakeDiscord([
      jsonResponse(429, { retry_after: 0 }),
      jsonResponse(429, { retry_after: 0 }),
      jsonResponse(429, { retry_after: 0 }),
    ]);

    await assert.rejects(
      postDiscordMessage({
        botToken: 'bot-token',
        fetchImpl: discord.fetchImpl,
        channelId: 'channel-1',
        message: { content: 'the pull request is ready' },
      }),
      /failed: 429/,
    );
    assert.equal(discord.calls.length, 3);
  });

  // How long it waited is not asserted: the fallback is a second, and timing the sleep
  // measures the host's clock instead of this code.
  test('When the 429 says nothing about the wait then should still try again', async () => {
    const discord = fakeDiscord([
      new Response('rate limited', { status: 429 }),
      jsonResponse(200, { id: 'message-1', channel_id: 'channel-1' }),
    ]);

    const posted = await postDiscordMessage({
      botToken: 'bot-token',
      fetchImpl: discord.fetchImpl,
      channelId: 'channel-1',
      message: { content: 'the pull request is ready' },
    });

    assert.equal(posted.messageId, 'message-1');
    assert.equal(discord.calls.length, 2);
  });

  test('When the 429 carries no wait in its body then should read the header', async () => {
    const discord = fakeDiscord([
      new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }),
      jsonResponse(200, { id: 'message-1', channel_id: 'channel-1' }),
    ]);

    const posted = await postDiscordMessage({
      botToken: 'bot-token',
      fetchImpl: discord.fetchImpl,
      channelId: 'channel-1',
      message: { content: 'the pull request is ready' },
    });

    assert.equal(posted.messageId, 'message-1');
  });
});

describe('Discord replies the client cannot read', () => {
  test('When Discord answers with an error status then should report the status and the body', async () => {
    const discord = fakeDiscord([jsonResponse(403, { message: 'Missing Access' })]);

    await assert.rejects(
      postDiscordMessage({
        botToken: 'bot-token',
        fetchImpl: discord.fetchImpl,
        channelId: 'channel-1',
        message: { content: 'the pull request is ready' },
      }),
      /POST \/channels\/channel-1\/messages failed: 403 .*Missing Access/,
    );
  });

  test('When Discord answers with something other than JSON then should return error', async () => {
    const discord = fakeDiscord([new Response('<html>gateway</html>', { status: 200 })]);

    await assert.rejects(
      postDiscordMessage({
        botToken: 'bot-token',
        fetchImpl: discord.fetchImpl,
        channelId: 'channel-1',
        message: { content: 'the pull request is ready' },
      }),
      /returned invalid JSON/,
    );
  });
});

interface DiscordCall {
  url: string;
  method: string;
  authorization: string | undefined;
  body: unknown;
}

interface FakeDiscord {
  fetchImpl: typeof fetch;
  calls: DiscordCall[];
}

function fakeDiscord(responses: Response[]): FakeDiscord {
  const calls: DiscordCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const response = responses[calls.length - 1];
    if (!response) throw new Error(`no fake response for call ${calls.length}`);
    return response;
  };
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response('', { status });
}
