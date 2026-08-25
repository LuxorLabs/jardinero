import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { type AppConfig, loadConfig } from '../../config.js';
import type { WorkAnnouncer, WorkConversation } from '../../orchestrator/work-announcer.js';
import type { Store } from '../../store/store.js';
import { type StoreFixture, createTestStore } from '../../testing/store.js';
import { eventually } from '../../testing/http.js';
import { createDiscordWorkAnnouncer } from './discord-announcer.js';

let fixture: StoreFixture;
let store: Store;
let config: AppConfig;
let posts: Array<{ channelId: string; content: string }>;
let mentions: string[][];
let refusingChannelIds: Set<string>;
let openedThreads: number;
let repositoryId: string;

beforeEach(() => {
  fixture = createTestStore();
  store = fixture.store;
  config = loadConfig();
  config.discord.enabled = true;
  config.discord.repoChannels = { 'acme/orchestrator': 'channel-repo' };
  config.discord.alertsChannelId = 'channel-alerts';
  repositoryId = store.upsertRepository('acme/orchestrator').id;
  posts = [];
  mentions = [];
  refusingChannelIds = new Set();
  openedThreads = 0;
});

afterEach(() => {
  fixture.cleanup();
});

describe('createDiscordWorkAnnouncer', () => {
  const cases: Array<{
    name: string;
    announce(announcer: WorkAnnouncer, work: WorkConversation): void;
    wantContent: string;
    wantChannelIds?: string[];
  }> = [
    {
      name: 'When the ticket starts being written then should say which one',
      announce: (announcer, work) =>
        announcer.ticketImplementationStarted(work, { identifier: 'JAR-58' }),
      wantContent: 'Writing JAR-58.',
    },
    {
      name: 'When the pass is being verified then should say so',
      announce: (announcer, work) =>
        announcer.ticketVerificationStarted(work, { identifier: 'JAR-58' }),
      wantContent: 'Verifying what was written for JAR-58.',
    },
    {
      name: 'When verification turned a pass down then should say which attempt goes next',
      announce: (announcer, work) =>
        announcer.ticketRejectedByVerifier(work, { identifier: 'JAR-58', attempt: 2 }),
      wantContent: 'Verification turned that pass down, writing JAR-58 again (attempt 2).',
    },
    {
      // Somebody has to step in, so the operator's channel hears it too.
      name: 'When the ticket parks then should say why, in the conversation and in alerts',
      announce: (announcer, work) =>
        announcer.ticketParked(work, { identifier: 'JAR-58', reason: 'iterations_exhausted' }),
      wantContent: 'JAR-58 needs a person: iterations\\_exhausted.',
      wantChannelIds: ['channel-repo', 'channel-alerts'],
    },
    {
      // What is recorded is text, not markup, and Discord renders what we post.
      name: 'When a reason reads as markup then should say it as it was written',
      announce: (announcer, work) =>
        announcer.ticketParked(work, {
          identifier: 'JAR-58',
          reason: 'the [login page](https://elsewhere.example) is _gone_',
        }),
      wantContent:
        'JAR-58 needs a person: the \\[login page\\](https://elsewhere.example) is \\_gone\\_.',
      wantChannelIds: ['channel-repo', 'channel-alerts'],
    },
    {
      name: 'When the ticket parks with no reason recorded then should say that',
      announce: (announcer, work) =>
        announcer.ticketParked(work, { identifier: 'JAR-58', reason: null }),
      wantContent: 'JAR-58 needs a person: no reason was recorded.',
      wantChannelIds: ['channel-repo', 'channel-alerts'],
    },
    {
      name: 'When a fix parks then should say why, in the conversation and in alerts',
      announce: (announcer, work) => announcer.fixParked(work, { reason: 'no_iterations_left' }),
      wantContent: 'A fix needs a person: no\\_iterations\\_left.',
      wantChannelIds: ['channel-repo', 'channel-alerts'],
    },
    {
      // The only moment that says a pull request exists: whoever wrote it stays quiet and
      // the machine that owns it from here on does the talking.
      name: 'When a pull request is adopted then should say it is ready for review',
      announce: (announcer, work) => announcer.pullRequestAdopted(work, { number: 4688 }),
      wantContent: '#4688 is ready for review.',
    },
    {
      name: 'When the passes run out then should say why, in the conversation and in alerts',
      announce: (announcer, work) =>
        announcer.pullRequestMaintenanceParked(work, {
          number: 4688,
          reason: 'attempts_exhausted',
        }),
      wantContent: '#4688 needs a person: attempts\\_exhausted.',
      wantChannelIds: ['channel-repo', 'channel-alerts'],
    },
    {
      name: 'When the pull request merges then should say so',
      announce: (announcer, work) => announcer.pullRequestMerged(work, { number: 4688 }),
      wantContent: '#4688 was merged.',
    },
    {
      name: 'When the pull request closes unmerged then should say so',
      announce: (announcer, work) => announcer.pullRequestClosed(work, { number: 4688 }),
      wantContent: '#4688 was closed without merging.',
    },
    {
      name: 'When a request could not be placed then should answer with the questions',
      announce: (announcer, work) =>
        announcer.requestUnresolvable(work, { questions: 'which repository?' }),
      wantContent: 'That request could not be placed: which repository?.',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      testCase.announce(announcer(), conversation());

      await eventually(() => {
        assert.deepEqual(
          posts,
          (testCase.wantChannelIds ?? ['channel-repo']).map((channelId) => ({
            channelId,
            content: testCase.wantContent,
          })),
        );
      });
    });
  }
});

describe('Where a moment is announced', () => {
  const cases: Array<{ name: string; arrange?(): void; wantChannelIds: string[] }> = [
    {
      name: 'When the work has no conversation yet then should open it in the repository channel',
      wantChannelIds: ['channel-repo'],
    },
    {
      name: 'When the work already has a conversation then should keep talking in its thread',
      arrange: () => {
        store.saveDiscordConversation({ conversationKey: 'work-1', threadId: 'thread-known' });
      },
      wantChannelIds: ['thread-known'],
    },
    {
      name: 'When the repository has no channel and there is no default then should say nothing',
      arrange: () => {
        config.discord.repoChannels = {};
      },
      wantChannelIds: [],
    },
    {
      name: 'When Discord is disabled then should say nothing',
      arrange: () => {
        config.discord.enabled = false;
      },
      wantChannelIds: [],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      testCase.arrange?.();

      announcer().ticketImplementationStarted(conversation(), { identifier: 'JAR-58' });

      await settled();
      assert.deepEqual(
        posts.map((post) => post.channelId),
        testCase.wantChannelIds,
      );
    });
  }
});

describe('The conversation a work keeps', () => {
  test('When a conversation is opened then should keep it for the next moment', async () => {
    announcer().ticketImplementationStarted(conversation(), { identifier: 'JAR-58' });
    await eventually(() =>
      assert.equal(store.findDiscordConversation('work-1')?.threadId, 'thread-opened'),
    );

    announcer().ticketVerificationStarted(conversation(), { identifier: 'JAR-58' });

    await eventually(() =>
      assert.deepEqual(
        posts.map((post) => post.channelId),
        ['channel-repo', 'thread-opened'],
      ),
    );
  });

  test('When they arrive together then should open one thread and say both in it', async () => {
    const announcing = announcer();

    announcing.ticketImplementationStarted(conversation(), { identifier: 'JAR-58' });
    announcing.ticketVerificationStarted(conversation(), { identifier: 'JAR-58' });

    await eventually(() => {
      assert.equal(openedThreads, 1);
      assert.deepEqual(
        posts.map((post) => post.channelId),
        ['channel-repo', 'thread-opened'],
      );
    });
  });
});

// A thread nothing has been said in is drawn nowhere in the channel, so what opens it has
// to be said inside it and not only about it.
describe('Where the work can be watched', () => {
  const WATCHING =
    'Follow it [here](https://jardinero.example.test/dashboard/operation?workflow_instance_id=instance-1).';
  const cases: Array<{
    name: string;
    arrange?(): void;
    wantPosts: Array<{ channelId: string; content: string }>;
  }> = [
    {
      name: 'When a conversation is opened then should say inside the thread where to watch it',
      arrange: () => {
        config.server.publicUrl = 'https://jardinero.example.test';
      },
      wantPosts: [
        { channelId: 'channel-repo', content: 'Writing JAR-58.' },
        { channelId: 'thread-opened', content: WATCHING },
      ],
    },
    {
      // Nowhere to send anybody, so the thread is opened with nothing said in it.
      name: 'When the deployment has no public url then should say only the moment',
      wantPosts: [{ channelId: 'channel-repo', content: 'Writing JAR-58.' }],
    },
    {
      name: 'When the work already has a conversation then should say only the moment',
      arrange: () => {
        config.server.publicUrl = 'https://jardinero.example.test';
        store.saveDiscordConversation({ conversationKey: 'work-1', threadId: 'thread-known' });
      },
      wantPosts: [{ channelId: 'thread-known', content: 'Writing JAR-58.' }],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      testCase.arrange?.();

      announcer().ticketImplementationStarted(conversation(), { identifier: 'JAR-58' });

      await settled();
      assert.deepEqual(posts, testCase.wantPosts);
    });
  }
});

describe('Who a moment names', () => {
  const cases: Array<{
    name: string;
    askedBy?: { source: string; externalId: string };
    wantMentions: string[];
  }> = [
    {
      name: 'When it was asked for on Discord then should name that account',
      askedBy: { source: 'discord', externalId: '1001' },
      wantMentions: ['1001'],
    },
    {
      name: 'When it was delegated in Linear then should name the same person on Discord',
      askedBy: { source: 'linear', externalId: 'linear-1' },
      wantMentions: ['1001'],
    },
    {
      name: 'When it was asked for on GitHub then should name the same person on Discord',
      askedBy: { source: 'github', externalId: 'octocat' },
      wantMentions: ['1001'],
    },
    {
      name: 'When the config does not know them then should name nobody',
      askedBy: { source: 'linear', externalId: 'linear-9' },
      wantMentions: [],
    },
    {
      name: 'When nobody asked then should name nobody',
      askedBy: undefined,
      wantMentions: [],
    },
    {
      name: 'When it came through a door with no people then should name nobody',
      askedBy: { source: 'cron', externalId: 'nightly' },
      wantMentions: [],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      config.people = [
        {
          discordUserId: '1001',
          discordUsername: 'octo',
          githubLogin: 'octocat',
          linearUserId: 'linear-1',
        },
      ];

      announcer().ticketImplementationStarted(
        { ...conversation(), ...(testCase.askedBy ? { askedBy: testCase.askedBy } : {}) },
        { identifier: 'JAR-58' },
      );

      await eventually(() => assert.deepEqual(mentions, [testCase.wantMentions]));
    });
  }
});

describe('Announcements that never land', () => {
  test('When Discord refuses the message then should record the moment that was lost', async () => {
    refusingChannelIds.add('channel-repo');

    announcer().ticketImplementationStarted(conversation(), { identifier: 'JAR-58' });

    await eventually(() => {
      const recorded = store
        .listEvents({}, { limit: 20 })
        .rows.filter((event) => event.eventType === 'orchestrator.discord_announce_failed');
      assert.equal(recorded.length, 1);
      assert.match(String(recorded[0]?.metadata), /ticketImplementationStarted/);
    });
  });

  // The operator's channel is the redundancy, so it is worth the most exactly when the
  // work's own thread is the one that cannot be reached.
  test('When the bot token is unset then should say nothing', async () => {
    createDiscordWorkAnnouncer({ config, store, env: {} }).ticketImplementationStarted(
      conversation(),
      { identifier: 'JAR-58' },
    );

    await settled();
    assert.deepEqual(posts, []);
  });

  // The link is cosmetic: a thread that refuses it must not turn a moment that already
  // landed into a failure, nor leave the conversation unusable for the next one.
  test('When the thread refuses the watch link then should keep the moment and record nothing', async () => {
    config.server.publicUrl = 'https://jardinero.example.test';
    refusingChannelIds.add('thread-opened');

    announcer().ticketImplementationStarted(conversation(), { identifier: 'JAR-58' });

    await settled();
    assert.deepEqual(posts, [{ channelId: 'channel-repo', content: 'Writing JAR-58.' }]);
    assert.equal(store.findDiscordConversation('work-1')?.threadId, 'thread-opened');
    assert.deepEqual(
      store
        .listEvents({}, { limit: 20 })
        .rows.filter((event) => event.eventType === 'orchestrator.discord_announce_failed'),
      [],
    );
  });

  test('When the conversation refuses it then should still reach the operator', async () => {
    refusingChannelIds.add('channel-repo');

    announcer().ticketParked(conversation(), { identifier: 'JAR-58', reason: 'run_failed' });

    await eventually(() =>
      assert.deepEqual(
        posts.map((post) => post.channelId),
        ['channel-alerts'],
      ),
    );
  });
});

// The announcement is fire and forget, so a case that expects silence has to let the
// scheduled work run before it can say nothing happened.
function settled(): Promise<unknown> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function conversation(): WorkConversation {
  return { key: 'work-1', name: 'JAR-58', repositoryId, workflowInstanceId: 'instance-1' };
}

function announcer(): WorkAnnouncer {
  return createDiscordWorkAnnouncer({
    config,
    store,
    env: { [config.discord.botTokenEnv]: 'bot-token' },
    fetchImpl: (async (input: unknown, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const channelId = String(input).split('/channels/')[1]?.split('/')[0] ?? '';
      if (refusingChannelIds.has(channelId)) {
        return new Response('{"message":"Missing Access"}', { status: 403 });
      }
      // Opening a thread is not something anybody reads, so only messages are recorded.
      if (String(input).endsWith('/threads')) {
        openedThreads += 1;
        return new Response(JSON.stringify({ id: 'thread-opened' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      posts.push({ channelId, content: String(body.content) });
      mentions.push((body.allowed_mentions?.users ?? []) as string[]);
      return new Response(JSON.stringify({ id: 'message-1', channel_id: channelId }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
}
