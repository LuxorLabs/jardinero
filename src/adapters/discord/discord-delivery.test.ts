import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { type AppConfig, loadConfig } from '../../config.js';
import type { OpenWork } from '../../orchestrator/open-work.js';
import type { Store } from '../../store/store.js';
import { type StoreFixture, createTestStore } from '../../testing/store.js';
import {
  type DiscordCommandReading,
  type DiscordDeliveryDeps,
  handleDiscordCommand,
  inferRepository,
  readDiscordCommand,
} from './discord-delivery.js';
import { type DiscordCommandInvocation, readDiscordInteraction } from './discord-interaction.js';

let fixture: StoreFixture;
let store: Store;
let config: AppConfig;
let repositoryId: string;
let sharedChannelRepositoryId: string;
let delegatedTickets: string[];
let delegationError: Error | undefined;
let openedTickets: Array<{ teamKey: string; text: string; ownerLinearUserId?: string }>;
let openingError: Error | undefined;
let discordCalls: Array<{ url: string; body: Record<string, unknown> }>;
let editFails: boolean;
let openWork: OpenWork[];
let conversationKeysAsked: string[];
let channelRefuses: boolean;

beforeEach(() => {
  fixture = createTestStore();
  store = fixture.store;
  config = loadConfig();
  config.server.publicUrl = 'https://jardinero.example.test';
  config.discord.enabled = true;
  config.workflows.linearImplementer.teamRepos = {
    JAR: 'acme/orchestrator',
    SYS: { default: 'acme/fleet', projects: {}, repos: ['acme/energy'] },
  };
  config.discord.repoChannels = {
    'acme/orchestrator': 'channel-1',
    'acme/fleet': 'channel-shared',
    'acme/energy': 'channel-shared',
  };
  repositoryId = store.upsertRepository('acme/orchestrator').id;
  sharedChannelRepositoryId = store.upsertRepository('acme/fleet').id;
  delegatedTickets = [];
  delegationError = undefined;
  openedTickets = [];
  openingError = undefined;
  discordCalls = [];
  editFails = false;
  openWork = [];
  conversationKeysAsked = [];
  channelRefuses = false;
});

afterEach(() => {
  fixture.cleanup();
});

describe('handleDiscordCommand', () => {
  const cases: Array<{
    name: string;
    arrange?(): void;
    commandName?: string;
    options?: Array<{ name: string; value: string }>;
    channelId?: string;
    wantOutcome: { handled: boolean; reason?: string };
    wantReply: string;
  }> = [
    {
      name: 'When work is asked for in words then should open the ticket and follow it in a thread',
      commandName: 'jardinero-code',
      options: [{ name: 'request', value: 'fix the typo in the miners tab' }],
      wantOutcome: { handled: true },
      wantReply: 'Opened JAR-79 and started on it. Follow it in <#thread-1>.',
    },
    {
      name: 'When the code command names no repository then should ask for one',
      commandName: 'jardinero-code',
      options: [{ name: 'request', value: 'fix the typo in the miners tab' }],
      channelId: 'channel-9',
      wantOutcome: { handled: false, reason: 'no_repository' },
      wantReply: 'Nothing says which repository this is about; name one with `repo`.',
    },
    {
      // Nothing says which team numbers that repository, so there is nowhere to write it.
      name: 'When the repository belongs to no Linear team then should ask for the identifier',
      commandName: 'jardinero-code',
      options: [
        { name: 'request', value: 'fix the typo in the miners tab' },
        { name: 'repo', value: 'ledger' },
      ],
      arrange: () => {
        store.upsertRepository('acme/ledger');
      },
      wantOutcome: { handled: false, reason: 'ticket_needs_team' },
      wantReply:
        'Nothing says which Linear team numbers that repository; write the whole identifier, such as `SYS-1191`.',
    },
    {
      // The ticket is there, so saying so is what keeps somebody from writing a second one.
      name: 'When the ticket is opened but not started then should say how to start it',
      commandName: 'jardinero-code',
      options: [{ name: 'request', value: 'fix the typo in the miners tab' }],
      arrange: () => {
        delegationError = new Error('linear refused to delegate JAR-79');
      },
      wantOutcome: { handled: false, reason: 'linear refused to delegate JAR-79' },
      wantReply:
        'Opened JAR-79, but it could not be started: linear refused to delegate JAR-79. Ask for it again with `/jardinero-ticket ticket:JAR-79`.',
    },
    {
      name: 'When the ticket cannot be opened then should answer with the reason',
      commandName: 'jardinero-code',
      options: [{ name: 'request', value: 'fix the typo in the miners tab' }],
      arrange: () => {
        openingError = new Error('linear refused to open a ticket in JAR');
      },
      wantOutcome: { handled: false, reason: 'linear refused to open a ticket in JAR' },
      wantReply: 'That could not be started: linear refused to open a ticket in JAR.',
    },
    {
      // The ticket exists and is being worked on, which is worth more than the thread.
      name: 'When the thread cannot be opened then should still say what the ticket is called',
      commandName: 'jardinero-code',
      options: [{ name: 'request', value: 'fix the typo in the miners tab' }],
      arrange: () => {
        channelRefuses = true;
      },
      wantOutcome: { handled: true, reason: 'thread_not_opened' },
      wantReply:
        'Opened JAR-79 and started on it. I cannot open a thread in this channel; an operator has to give Jardinero access to it.',
    },
    {
      name: 'When the status names a ticket then should answer it outside its thread',
      commandName: 'jardinero-status',
      options: [{ name: 'ticket', value: 'JAR-58' }],
      arrange: () => {
        openWork = [
          {
            workflowType: 'linear_implementer',
            workflowInstanceId: 'instance-1',
            repositoryFullName: 'acme/orchestrator',
            name: 'JAR-58',
            happening: 'being verified',
            needsPerson: false,
          },
        ];
      },
      wantOutcome: { handled: true },
      wantReply:
        '- JAR-58 is being verified — [watch](https://jardinero.example.test/dashboard/operation?workflow_instance_id=instance-1)',
    },
    {
      // Nothing to link to, so the work is still named rather than dropped.
      name: 'When the deployment has no public url then should answer without a link',
      commandName: 'jardinero-status',
      options: [{ name: 'ticket', value: 'JAR-58' }],
      arrange: () => {
        config.server.publicUrl = '';
        openWork = [
          {
            workflowType: 'linear_implementer',
            workflowInstanceId: 'instance-1',
            repositoryFullName: 'acme/orchestrator',
            name: 'JAR-58',
            happening: 'being verified',
            needsPerson: false,
          },
        ];
      },
      wantOutcome: { handled: true },
      wantReply: '- JAR-58 is being verified',
    },
    {
      name: 'When the status names a ticket we have no work for then should say there is none',
      commandName: 'jardinero-status',
      options: [{ name: 'ticket', value: 'JAR-58' }],
      wantOutcome: { handled: true },
      wantReply: 'I have nothing on `JAR-58`.',
    },
    {
      // A ticket is named by its identifier alone here, so a bare number says nothing.
      name: 'When the status names no identifier then should say what one looks like',
      commandName: 'jardinero-status',
      options: [{ name: 'ticket', value: '58' }],
      wantOutcome: { handled: true },
      wantReply: '`58` is not a Linear identifier, such as `JAR-58`.',
    },
    {
      // Asked anywhere else there is no work to be asked about.
      name: 'When the status is asked outside a work thread then should say where to ask it',
      commandName: 'jardinero-status',
      options: [],
      wantOutcome: { handled: true },
      wantReply: 'Name a ticket, or ask me inside the thread of the work you want the status of.',
    },
    {
      name: 'When the status is asked inside a work thread then should answer that work alone',
      commandName: 'jardinero-status',
      options: [],
      channelId: 'thread-1',
      arrange: () => {
        store.saveDiscordConversation({
          conversationKey: 'linear_issue:JAR-58',
          threadId: 'thread-1',
        });
        openWork = [
          {
            workflowType: 'linear_implementer',
            workflowInstanceId: 'instance-1',
            repositoryFullName: 'acme/orchestrator',
            name: 'JAR-58',
            happening: 'being verified',
            needsPerson: false,
          },
          {
            workflowType: 'pr_maintainer',
            workflowInstanceId: 'instance-2',
            repositoryFullName: 'acme/orchestrator',
            name: '#4688',
            happening: 'waiting for a review',
            needsPerson: false,
          },
        ];
      },
      wantOutcome: { handled: true },
      wantReply: [
        '- JAR-58 is being verified — [watch](https://jardinero.example.test/dashboard/operation?workflow_instance_id=instance-1)',
        '- #4688 is waiting for a review — [watch](https://jardinero.example.test/dashboard/operation?workflow_instance_id=instance-2)',
      ].join('\n'),
    },
    {
      // The thread is ours and the work behind it is gone, so there is nothing to report.
      name: 'When the thread follows work we no longer have then should say where to ask it',
      commandName: 'jardinero-status',
      options: [],
      channelId: 'thread-1',
      arrange: () => {
        store.saveDiscordConversation({
          conversationKey: 'linear_issue:JAR-58',
          threadId: 'thread-1',
        });
      },
      wantOutcome: { handled: true },
      wantReply: 'Name a ticket, or ask me inside the thread of the work you want the status of.',
    },
    {
      name: 'When nothing says which repository then should ask for one',
      options: [{ name: 'ticket', value: '58' }],
      channelId: 'channel-9',
      wantOutcome: { handled: false, reason: 'no_repository' },
      wantReply: 'Nothing says which repository this is about; name one with `repo`.',
    },
    {
      name: 'When the repository is not one we work on then should refuse it',
      options: [
        { name: 'ticket', value: 'JAR-58' },
        { name: 'repo', value: 'acme/unconfigured' },
      ],
      wantOutcome: { handled: false, reason: 'unknown_repository' },
      wantReply: 'That repository is not one Jardinero works on.',
    },
    {
      name: 'When a bare name matches several repositories then should ask for the owner',
      arrange: () => {
        store.upsertRepository('other-org/orchestrator');
      },
      options: [
        { name: 'ticket', value: 'JAR-58' },
        { name: 'repo', value: 'orchestrator' },
      ],
      wantOutcome: { handled: false, reason: 'ambiguous_repository' },
      wantReply: 'More than one repository is named that; write it as `owner/repo`.',
    },
    {
      name: 'When a bare number names no team of that repository then should ask for the whole identifier',
      arrange: () => {
        config.workflows.linearImplementer.teamRepos = {};
      },
      options: [{ name: 'ticket', value: '58' }],
      wantOutcome: { handled: false, reason: 'ticket_needs_team' },
      wantReply:
        'Nothing says which Linear team numbers that repository; write the whole identifier, such as `SYS-1191`.',
    },
    {
      name: 'When the ticket carries no identifier then should say what one looks like',
      options: [{ name: 'ticket', value: 'the login page' }],
      wantOutcome: { handled: false, reason: 'unreadable_ticket' },
      wantReply: '`the login page` is not a Linear identifier, such as `JAR-58`.',
    },
    {
      name: 'When the ticket cannot be delegated then should answer with the reason',
      arrange: () => {
        delegationError = new Error('linear refused to assign JAR-58');
      },
      wantOutcome: { handled: false, reason: 'linear refused to assign JAR-58' },
      wantReply: 'JAR-58 could not be started: linear refused to assign JAR-58.',
    },
    {
      // Discord refuses what the bot cannot reach, and the acknowledgement is the only
      // thing the person is looking at.
      name: 'When the channel refuses the message then should say so instead of going quiet',
      arrange: () => {
        channelRefuses = true;
      },
      wantOutcome: { handled: false, reason: 'thread_not_opened' },
      wantReply:
        'I cannot open a thread in this channel; an operator has to give Jardinero access to it.',
    },
    {
      name: 'When the ticket is one we work on then should answer where it is followed',
      wantOutcome: { handled: true },
      wantReply: 'Received JAR-58. Follow it in <#thread-1>.',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      testCase.arrange?.();

      const outcome = await handleDiscordCommand(
        deps(),
        invocation({
          commandName: testCase.commandName,
          options: testCase.options,
          channelId: testCase.channelId,
        }),
      );

      assert.deepEqual(outcome, testCase.wantOutcome);
      assert.equal(lastReply(), testCase.wantReply);
    });
  }
});

describe('The conversation a status command reads', () => {
  test('When the status names a ticket then should read that ticket and not the channel', async () => {
    store.saveDiscordConversation({ conversationKey: 'linear_issue:JAR-99', threadId: 'thread-1' });

    await handleDiscordCommand(
      deps(),
      invocation({
        commandName: 'jardinero-status',
        options: [{ name: 'ticket', value: 'jar-58' }],
        channelId: 'thread-1',
      }),
    );

    assert.deepEqual(conversationKeysAsked, ['linear_issue:JAR-58']);
  });
});

describe('Discord commands that open work', () => {
  test('When a ticket is asked for then should record the request the thread follows', async () => {
    await handleDiscordCommand(deps(), invocation({}));

    const request = store.listRequests({}, { limit: 10 }).rows.at(0);
    assert.equal(request?.requestSource, 'discord');
    assert.equal(request?.requestText, 'JAR-58');
    assert.equal(request?.requesterExternalId, '1001');
    assert.equal(request?.replyTargetType, 'discord_thread');
    assert.equal(request?.replyTargetId, 'thread-1');
    assert.equal(request?.repositoryId, repositoryId);
    assert.equal(request?.subjectType, 'linear_issue');
    assert.equal(request?.subjectExternalId, 'JAR-58');
    // Born resolved: the subject came with the command, so no agent has to place it.
    assert.equal(request?.workflowState, 'rr_resolved');
    assert.deepEqual(delegatedTickets, ['JAR-58']);
  });

  test('When work is asked for in words then should record the ask the thread follows', async () => {
    await handleDiscordCommand(
      deps(),
      invocation({
        commandName: 'jardinero-code',
        options: [{ name: 'request', value: 'fix the typo in the miners tab' }],
      }),
    );

    const ask = store.listRequests({}, { limit: 10 }).rows.at(0);
    assert.equal(ask?.requestSource, 'discord');
    assert.equal(ask?.requestText, 'fix the typo in the miners tab');
    assert.equal(ask?.requesterExternalId, '1001');
    assert.equal(ask?.replyTargetType, 'discord_thread');
    assert.equal(ask?.replyTargetId, 'thread-1');
    assert.equal(ask?.repositoryId, repositoryId);
    assert.equal(ask?.subjectExternalId, 'JAR-79');
    assert.deepEqual(delegatedTickets, ['issue-uuid-79']);
  });

  test('When the ticket cannot be started then should give up on the ask', async () => {
    delegationError = new Error('linear refused to delegate JAR-79');

    await handleDiscordCommand(
      deps(),
      invocation({
        commandName: 'jardinero-code',
        options: [{ name: 'request', value: 'fix the typo in the miners tab' }],
      }),
    );

    const ask = store.listRequests({}, { limit: 10 }).rows.at(0);
    assert.equal(ask?.workflowState, 'rr_unresolvable');
    assert.deepEqual(store.listUnconsumedRequests('linear_issue', 'JAR-79'), []);
  });

  test('When the ticket is asked for twice then should keep talking in the same thread', async () => {
    await handleDiscordCommand(deps(), invocation({}));
    discordCalls.length = 0;

    const outcome = await handleDiscordCommand(deps(), invocation({}));

    assert.deepEqual(outcome, { handled: true });
    assert.equal(lastReply(), 'Received JAR-58. Follow it in <#thread-1>.');
    assert.equal(
      discordCalls.some((call) => call.url.endsWith('/threads')),
      false,
    );
  });

  test('When the ticket cannot be delegated then should give up on the ask', async () => {
    delegationError = new Error('linear refused to assign JAR-58');

    await handleDiscordCommand(deps(), invocation({}));

    const request = store.listRequests({}, { limit: 10 }).rows.at(0);
    assert.equal(request?.workflowState, 'rr_unresolvable');
    assert.equal(request?.resolutionNote, 'linear refused to assign JAR-58');
    assert.deepEqual(store.listUnconsumedRequests('linear_issue', 'JAR-58'), []);
  });

  test('When the thread is opened then should hang it off a message naming who asked', async () => {
    await handleDiscordCommand(deps(), invocation({}));

    assert.deepEqual(discordCalls[0], {
      url: 'https://discord.com/api/v10/channels/channel-1/messages',
      body: {
        content: '<@1001> asked Jardinero to implement JAR-58',
        allowed_mentions: { parse: [], users: [] },
        flags: 4,
      },
    });
    assert.equal(
      discordCalls[1]?.url,
      'https://discord.com/api/v10/channels/channel-1/messages/message-1/threads',
    );
  });

  test('When a command is refused then should open no thread and no request', async () => {
    await handleDiscordCommand(
      deps(),
      invocation({ options: [{ name: 'ticket', value: '58' }], channelId: 'channel-9' }),
    );

    assert.equal(store.listRequests({}, { limit: 10 }).rows.length, 0);
    assert.equal(discordCalls.length, 1);
  });
});

describe('Discord answers that never land', () => {
  test('When the answer cannot be posted then should record it and keep the outcome', async () => {
    editFails = true;

    const outcome = await handleDiscordCommand(deps(), invocation({}));

    assert.deepEqual(outcome, { handled: true });
    const recorded = store
      .listEvents({}, { limit: 20 })
      .rows.filter((event) => event.eventType === 'orchestrator.discord_reply_failed');
    assert.equal(recorded.length, 1);
  });
});

describe('inferRepository', () => {
  const cases: Array<{
    name: string;
    ticket?: string;
    repo?: string;
    channelId?: string;
    wantRepositoryFullName?: string;
  }> = [
    {
      name: 'When the ticket carries no team and none is named then should take the channel one',
      ticket: '58',
      wantRepositoryFullName: 'acme/orchestrator',
    },
    {
      // The ticket says what the work is; the channel is only where it was typed.
      name: 'When the ticket carries a team and none is named then should take that team',
      ticket: 'JAR-58',
      channelId: 'channel-shared',
      wantRepositoryFullName: 'acme/orchestrator',
    },
    {
      name: 'When a repository is named and the ticket carries no team then should take the named one',
      ticket: '58',
      repo: 'acme/energy',
      wantRepositoryFullName: 'acme/energy',
    },
    {
      name: 'When a repository is named and the ticket carries a team then should take the named one',
      ticket: 'JAR-58',
      repo: 'acme/energy',
      wantRepositoryFullName: 'acme/energy',
    },
    {
      // Two repositories report to that channel, and the config's order is what makes the
      // first one its default.
      name: 'When several repositories share the channel then should take the first configured',
      ticket: '58',
      channelId: 'channel-shared',
      wantRepositoryFullName: 'acme/fleet',
    },
    {
      name: 'When the ticket names a team we work for nobody then should take the channel one',
      ticket: 'ZZZ-58',
      wantRepositoryFullName: 'acme/orchestrator',
    },
    {
      name: 'When nothing says which repository then should answer nothing',
      ticket: '58',
      channelId: 'channel-9',
      wantRepositoryFullName: undefined,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const named = inferRepository(
        deps(),
        invocation({
          options: [
            ...(testCase.ticket ? [{ name: 'ticket', value: testCase.ticket }] : []),
            ...(testCase.repo ? [{ name: 'repo', value: testCase.repo }] : []),
          ],
          channelId: testCase.channelId,
        }),
      );

      assert.equal(named, testCase.wantRepositoryFullName);
    });
  }
});

describe('readDiscordCommand', () => {
  const cases: Array<{
    name: string;
    arrange?(): void;
    options?: Array<{ name: string; value: string }>;
    channelId?: string;
    wantReading(): DiscordCommandReading;
  }> = [
    {
      // The ticket says what the work is; the channel is only where it was typed.
      name: 'When the ticket carries a team and none is named then should take that team',
      channelId: 'channel-shared',
      wantReading: () => ({
        repositoryFullName: 'acme/orchestrator',
        repositoryId,
        linearIssueIdentifier: 'JAR-58',
      }),
    },
    {
      // Two repositories report to that channel, and the config's order is what makes the
      // first one its default.
      name: 'When several repositories share the channel then should take the first configured',
      options: [{ name: 'ticket', value: '58' }],
      channelId: 'channel-shared',
      wantReading: () => ({
        repositoryFullName: 'acme/fleet',
        repositoryId: sharedChannelRepositoryId,
        linearIssueIdentifier: 'SYS-58',
      }),
    },
    {
      name: 'When nothing says which repository then should refuse it',
      options: [{ name: 'ticket', value: '58' }],
      channelId: 'channel-9',
      wantReading: () => ({ refused: 'no_repository' }),
    },
    {
      name: 'When the ticket is a Linear url then should read the identifier out of it',
      options: [{ name: 'ticket', value: 'https://linear.app/acme/issue/JAR-58/fix-the-typo' }],
      wantReading: () => ({
        repositoryFullName: 'acme/orchestrator',
        repositoryId,
        linearIssueIdentifier: 'JAR-58',
      }),
    },
    {
      name: 'When the identifier is written in lower case then should read it as Linear writes it',
      options: [{ name: 'ticket', value: 'jar-58' }],
      wantReading: () => ({
        repositoryFullName: 'acme/orchestrator',
        repositoryId,
        linearIssueIdentifier: 'JAR-58',
      }),
    },
    {
      name: 'When the repository is named without its owner then should resolve it',
      options: [
        { name: 'ticket', value: 'JAR-58' },
        { name: 'repo', value: 'fleet' },
      ],
      wantReading: () => ({
        repositoryFullName: 'acme/fleet',
        repositoryId: sharedChannelRepositoryId,
        linearIssueIdentifier: 'JAR-58',
      }),
    },
    {
      name: 'When two repositories are named the same then should ask for the owner',
      arrange: () => {
        store.upsertRepository('other-org/fleet');
      },
      options: [
        { name: 'ticket', value: 'JAR-58' },
        { name: 'repo', value: 'fleet' },
      ],
      wantReading: () => ({
        repositoryFullName: 'fleet',
        refused: 'ambiguous_repository',
      }),
    },
    {
      name: 'When the ticket is only a number then should take the prefix from the repository team',
      options: [{ name: 'ticket', value: '58' }],
      wantReading: () => ({
        repositoryFullName: 'acme/orchestrator',
        repositoryId,
        linearIssueIdentifier: 'JAR-58',
      }),
    },
    {
      // Nothing says which team numbers that repository, so the number cannot become an
      // identifier.
      name: 'When the repository belongs to no Linear team then should ask for the whole identifier',
      arrange: () => {
        store.upsertRepository('acme/ledger');
      },
      options: [
        { name: 'ticket', value: '58' },
        { name: 'repo', value: 'ledger' },
      ],
      wantReading: () => ({
        repositoryFullName: 'acme/ledger',
        repositoryId: store.upsertRepository('acme/ledger').id,
        refused: 'ticket_needs_team',
      }),
    },
    {
      name: 'When the ticket names no identifier then should refuse it',
      options: [{ name: 'ticket', value: 'the login page' }],
      wantReading: () => ({
        repositoryFullName: 'acme/orchestrator',
        repositoryId,
        refused: 'unreadable_ticket',
      }),
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      testCase.arrange?.();

      const reading = readDiscordCommand(
        deps(),
        invocation({ options: testCase.options, channelId: testCase.channelId }),
      );

      assert.deepEqual(reading, testCase.wantReading());
    });
  }
});

function deps(): DiscordDeliveryDeps {
  return {
    config,
    store,
    listWorkInConversation: (conversationKey) => {
      conversationKeysAsked.push(conversationKey);
      return openWork;
    },
    openTicketForRequest: async (request) => {
      if (openingError) return openingError;
      openedTickets.push(request);
      return { identifier: 'JAR-79', linearIssueId: 'issue-uuid-79' };
    },
    delegateTicket: async (ticket) => {
      if (delegationError) return delegationError;
      delegatedTickets.push(ticket.linearIssueId ?? ticket.identifier);
      return undefined;
    },
    env: {
      [config.discord.applicationIdEnv]: 'application-1',
      [config.discord.botTokenEnv]: 'bot-token',
    },
    fetchImpl: fakeDiscord(),
  };
}

// The three routes one command touches: the message the thread hangs off, the thread, and
// the answer that replaces the acknowledgement.
function fakeDiscord(): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    discordCalls.push({
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
    });
    if (channelRefuses && url.endsWith('/channels/channel-1/messages')) {
      return new Response('{"message":"Missing Access"}', { status: 403 });
    }
    if (url.endsWith('/threads')) {
      return jsonResponse({ id: 'thread-1' });
    }
    if (url.includes('/webhooks/')) {
      if (editFails) return new Response('', { status: 500 });
      return new Response('', { status: 200 });
    }
    return jsonResponse({ id: 'message-1', channel_id: 'channel-1' });
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function invocation(overrides: {
  commandName?: string;
  options?: Array<{ name: string; value: string }>;
  channelId?: string;
}): DiscordCommandInvocation {
  const reading = readDiscordInteraction({
    type: 2,
    id: 'interaction-1',
    token: 'interaction-token',
    channel_id: overrides.channelId ?? 'channel-1',
    member: { user: { id: '1001', username: 'octo' }, roles: ['role-1'] },
    data: {
      name: overrides.commandName ?? 'jardinero-ticket',
      options: overrides.options ?? [{ name: 'ticket', value: 'JAR-58' }],
    },
  });
  if (!reading.invocation) throw new Error(`the fixture built an unreadable interaction`);
  return reading.invocation;
}

function lastReply(): string | undefined {
  const edit = discordCalls.filter((call) => call.url.includes('/webhooks/')).at(-1);
  return typeof edit?.body.content === 'string' ? edit.body.content : undefined;
}
