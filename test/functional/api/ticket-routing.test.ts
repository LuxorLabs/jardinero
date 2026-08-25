import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { createDiscordSigner, discordCommandPayload } from '../../../src/testing/discord.js';
import type { RequestRouter } from '../../../src/store/types.js';
import {
  type HttpFixture,
  createHttpFixture,
  eventually,
  linearSessionBody,
  linearSignature,
} from '../../../src/testing/http.js';

// Everything that decides which repository a ticket is worked in, and what the ticket is
// called, from what a person typed on Discord. The command resolves one repository to
// record the ask against; the delivery Linear sends back resolves the one the work runs in,
// and only that one can see the ticket's project.
//
// | repo   | ticket   | channel       | project | asked against | ticket   | worked in |
// | --     | --       | --            | --      | --            | --       | --        |
// |        | SYS-1191 | #fleet        |         | fleet         | SYS-1191 | fleet     |
// |        | SYS-1192 | #fleet        | ENERGY  | fleet         | SYS-1192 | energy    |
// |        | 1193     | #fleet        |         | fleet         | SYS-1193 | fleet     |
// |        | 59       | #orchestrator |         | orchestrator  | JAR-59   | orchestrator |
// | fleet  | 1194     | #orchestrator |         | fleet         | SYS-1194 | fleet     |
// | energy | SYS-1195 | #orchestrator |         | energy        | SYS-1195 | fleet     |
// |        | 60       | unmapped      |         | refused       |          |           |
const CHANNELS = { orchestrator: 'channel-orchestrator', fleet: 'channel-fleet' };

let fixture: HttpFixture;
let signer: ReturnType<typeof createDiscordSigner>;
let discordCalls: Array<{ url: string; mutation?: string; body?: Record<string, unknown> }>;

before(async () => {
  discordCalls = [];
  signer = createDiscordSigner();
  fixture = await createHttpFixture(
    {
      DISCORD_PUBLIC_KEY: signer.publicKeyHex,
      DISCORD_APPLICATION_ID: 'application-1',
      DISCORD_BOT_TOKEN: 'bot-token',
      LINEAR_APP_TOKEN: 'linear-token',
      LINEAR_WEBHOOK_SECRET: 'linsecret',
    },
    {
      discordEnabled: true,
      discordAllowedRoleIds: ['role-1'],
      discordRepoChannels: {
        'acme/orchestrator': CHANNELS.orchestrator,
        'acme/fleet': CHANNELS.fleet,
      },
      linearEnabled: true,
      linearTeamRepos: {
        JAR: 'acme/orchestrator',
        SYS: {
          default: 'acme/fleet',
          projects: { ENERGY: 'acme/energy' },
          repos: ['acme/energy'],
        },
      },
      fetchImpl: stubbedDiscordAndLinear(),
    },
  );
  fixture.store.upsertRepository('acme/orchestrator');
  fixture.store.upsertRepository('acme/fleet');
  fixture.store.upsertRepository('acme/energy');
});

after(async () => {
  await fixture.cleanup();
});

describe('Which repository and ticket a command resolves to', () => {
  const cases: Array<{
    name: string;
    ticket: string;
    repo?: string;
    channelId: string;
    project?: { id: string; name: string };
    want: { askRepository: string; identifier: string; workRepository: string };
  }> = [
    {
      name: 'When the ticket carries its team then should take that team wherever it was typed',
      ticket: 'SYS-1191',
      channelId: CHANNELS.orchestrator,
      want: {
        askRepository: 'acme/fleet',
        identifier: 'SYS-1191',
        workRepository: 'acme/fleet',
      },
    },
    {
      // The command cannot see a project, so the two halves answer differently and the
      // delivery's answer is the one the work runs in.
      name: 'When the ticket belongs to a project then should run it where the project says',
      ticket: 'SYS-1192',
      channelId: CHANNELS.orchestrator,
      project: { id: 'project-energy', name: 'ENERGY' },
      want: {
        askRepository: 'acme/fleet',
        identifier: 'SYS-1192',
        workRepository: 'acme/energy',
      },
    },
    {
      name: 'When the ticket is only a number then should number it with the team of the channel',
      ticket: '1193',
      channelId: CHANNELS.fleet,
      want: {
        askRepository: 'acme/fleet',
        identifier: 'SYS-1193',
        workRepository: 'acme/fleet',
      },
    },
    {
      name: 'When a number is asked for in another channel then should number it with that team',
      ticket: '59',
      channelId: CHANNELS.orchestrator,
      want: {
        askRepository: 'acme/orchestrator',
        identifier: 'JAR-59',
        workRepository: 'acme/orchestrator',
      },
    },
    {
      name: 'When a repository is named then should take it over the ticket and the channel',
      ticket: '1194',
      repo: 'fleet',
      channelId: CHANNELS.orchestrator,
      want: {
        askRepository: 'acme/fleet',
        identifier: 'SYS-1194',
        workRepository: 'acme/fleet',
      },
    },
    {
      // A repository the team may select, named by hand: the command records it, and the
      // delivery still answers with the team's default because nothing else says otherwise.
      name: 'When the named repository is not where the team works then should keep both answers',
      ticket: 'SYS-1195',
      repo: 'energy',
      channelId: CHANNELS.orchestrator,
      want: {
        askRepository: 'acme/energy',
        identifier: 'SYS-1195',
        workRepository: 'acme/fleet',
      },
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    test(testCase.name, async () => {
      await runCommand(testCase, index);

      const ask = requestFor(testCase.want.identifier);
      assert.equal(ask?.subjectExternalId, testCase.want.identifier);
      assert.equal(repositoryName(ask?.repositoryId), testCase.want.askRepository);

      await deliverDelegation(testCase.want.identifier, testCase.project);

      await eventually(() => {
        const instance = fixture.store
          .listOpenLinearImplementers()
          .find((open) => open.linearIssueIdentifier === testCase.want.identifier);
        assert.equal(repositoryName(instance?.repositoryId), testCase.want.workRepository);
        // Answered, the ask stops saying where the command guessed and says where it landed.
        assert.equal(
          repositoryName(requestFor(testCase.want.identifier)?.repositoryId),
          testCase.want.workRepository,
        );
      });
    });
  }

  test('When nothing says which repository then should refuse it and ask for one', async () => {
    await runCommand({ ticket: '60', channelId: 'channel-nobody' }, cases.length);

    assert.equal(requestFor('60'), undefined);
    assert.deepEqual(fixture.store.listRequests({}, { limit: 50 }).rows.length, cases.length);
  });
});

async function runCommand(
  invocation: { ticket: string; repo?: string; channelId: string },
  index: number,
): Promise<void> {
  const signed = signer.sign(
    discordCommandPayload({
      commandName: 'jardinero-ticket',
      interactionId: `interaction-${index}`,
      channelId: invocation.channelId,
      options: [
        { name: 'ticket', value: invocation.ticket },
        ...(invocation.repo ? [{ name: 'repo', value: invocation.repo }] : []),
      ],
    }),
  );
  const response = await fetch(`${fixture.baseUrl}/webhooks/discord`, {
    method: 'POST',
    headers: signed.headers,
    body: signed.body,
  });
  assert.equal(response.status, 200);
  await eventually(() =>
    assert.ok(discordCalls.some((call) => call.url.includes('/webhooks/application-1'))),
  );
}

// The delegation Linear answers with, which is what opens the work.
async function deliverDelegation(
  identifier: string,
  project?: { id: string; name: string },
): Promise<void> {
  const body = linearSessionBody('created', {
    identifier,
    teamKey: identifier.slice(0, identifier.indexOf('-')),
    ...(project ? { project } : {}),
  });
  const response = await fetch(`${fixture.baseUrl}/webhooks/linear`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'linear-delivery': `delivery-${identifier}`,
      'linear-signature': linearSignature('linsecret', body),
    },
    body,
  });
  assert.equal(response.status, 202);
}

function requestFor(subjectExternalId: string): RequestRouter | undefined {
  return fixture.store
    .listRequests({}, { limit: 50 })
    .rows.find((row) => row.subjectExternalId === subjectExternalId);
}

function repositoryName(repositoryId: string | null | undefined): string | undefined {
  return repositoryId ? fixture.store.getRepositoryById(repositoryId)?.fullName : undefined;
}

function stubbedDiscordAndLinear(): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const sent = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    discordCalls.push({ url, mutation: sent.query, body: sent.variables });
    if (url.endsWith('/threads')) return jsonBody({ id: 'thread-1' });
    if (url.includes('discord.com/api')) {
      return url.includes('/messages') && !url.includes('/webhooks/')
        ? jsonBody({ id: 'message-1', channel_id: 'channel-1' })
        : new Response('', { status: 200 });
    }
    return jsonBody({
      data: {
        issues: { nodes: [{ id: 'issue-uuid', title: 'A ticket' }] },
        viewer: { id: 'app-user-1' },
        issueUpdate: { success: true },
        agentActivityCreate: { success: true },
        agentSessionUpdate: { success: true },
      },
    });
  };
}

function jsonBody(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
