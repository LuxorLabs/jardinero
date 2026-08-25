import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { discordCommandPayload, signDiscordInteraction } from '../../../src/testing/discord.js';
import {
  createHttpFixture,
  eventually,
  githubSignature,
  linearSessionBody,
  linearSignature,
} from '../../../src/testing/http.js';

describe('POST /webhooks/github', () => {
  test('When a comment tags the agent then should follow the pull request', async () => {
    const fixture = await createHttpFixture({ JARDINERO_AGENT_WEBHOOK_SECRET: 'whsecret' });
    try {
      const body = JSON.stringify({
        action: 'created',
        repository: { full_name: 'acme/webapp' },
        issue: {
          number: 3754,
          html_url: 'https://github.com/acme/webapp/pull/3754',
          user: { login: 'acme-jardinero[bot]' },
          pull_request: { url: 'https://api.github.com/repos/acme/webapp/pulls/3754' },
        },
        comment: { id: 4242, body: '@acme-jardinero please address this' },
      });
      const response = await fetch(`${fixture.baseUrl}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issue_comment',
          'x-github-delivery': 'delivery-1',
          'x-hub-signature-256': githubSignature('whsecret', body),
        },
        body,
      });

      assert.equal(response.status, 202);
      await eventually(() => {
        const instance = fixture.store.listOpenPrMaintainers().at(0);
        assert.equal(instance?.pullRequestNumber, 3754);
        assert.equal(instance?.workflowState, 'prm_working');
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test('When a pull request that is not ours leaves draft then should follow nothing', async () => {
    const fixture = await createHttpFixture({ JARDINERO_AGENT_WEBHOOK_SECRET: 'whsecret' });
    try {
      const body = JSON.stringify({
        action: 'ready_for_review',
        repository: { full_name: 'acme/ledger' },
        pull_request: {
          number: 1001,
          head: { ref: 'darolpz/pool-service-mock' },
          labels: [{ name: 'minor' }],
        },
      });
      const response = await fetch(`${fixture.baseUrl}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'delivery-ready',
          'x-hub-signature-256': githubSignature('whsecret', body),
        },
        body,
      });

      assert.equal(response.status, 202);
      assert.deepEqual(fixture.store.listOpenPrMaintainers(), []);
      assert.deepEqual(fixture.store.listSandboxRuns(1), []);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When a bot comments on a pull request nobody follows then should record no ask', async () => {
    const fixture = await createHttpFixture({ JARDINERO_AGENT_WEBHOOK_SECRET: 'whsecret' });
    try {
      const body = JSON.stringify({
        action: 'created',
        repository: { full_name: 'acme/web.app' },
        issue: { number: 4999, pull_request: { url: 'https://api.github.com/x' } },
        comment: {
          id: 77,
          body: '**Tenki Code Review** starting analysis',
          user: { login: 'tenki-reviewer[bot]' },
        },
      });
      const response = await fetch(`${fixture.baseUrl}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issue_comment',
          'x-github-delivery': 'delivery-bot-comment',
          'x-hub-signature-256': githubSignature('whsecret', body),
        },
        body,
      });

      assert.equal(response.status, 202);
      assert.deepEqual(fixture.store.listRequests({}, { limit: 10 }).rows, []);
      assert.deepEqual(fixture.store.listOpenPrMaintainers(), []);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When a deploy succeeds then should open a scan of the deployed repository', async () => {
    const fixture = await createHttpFixture({ JARDINERO_AGENT_WEBHOOK_SECRET: 'whsecret' });
    try {
      const body = JSON.stringify({
        action: 'created',
        repository: { full_name: 'acme/widgets' },
        deployment: { environment: 'production' },
        deployment_status: { state: 'success' },
      });
      const response = await fetch(`${fixture.baseUrl}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'deployment_status',
          'x-github-delivery': 'delivery-deploy',
          'x-hub-signature-256': githubSignature('whsecret', body),
        },
        body,
      });

      assert.equal(response.status, 202);
      await eventually(() => {
        const instance = fixture.store.listOpenLogReviewers().at(0);
        assert.equal(instance?.serviceName, 'widgets');
        assert.equal(instance?.workflowState, 'lr_working');
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the checks of a followed pull request go red then should pick it up again', async () => {
    const fixture = await createHttpFixture({ JARDINERO_AGENT_WEBHOOK_SECRET: 'whsecret' });
    try {
      const repositoryId = fixture.store.upsertRepository('acme/webapp').id;
      const instance = fixture.store.openPrMaintainer({ repositoryId, pullRequestNumber: 3754 });
      fixture.store.setPrMaintainerState(instance.id, 'prm_waiting', {
        needsHumanReason: 'waiting_on_review',
      });
      const body = JSON.stringify({
        action: 'completed',
        repository: { full_name: 'acme/webapp' },
        check_suite: { conclusion: 'failure', pull_requests: [{ number: 3754 }] },
      });
      const response = await fetch(`${fixture.baseUrl}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'check_suite',
          'x-github-delivery': 'delivery-checks',
          'x-hub-signature-256': githubSignature('whsecret', body),
        },
        body,
      });

      assert.equal(response.status, 202);
      await eventually(() => {
        const taken = fixture.store.getPrMaintainer(instance.id);
        assert.equal(taken?.workflowState, 'prm_working');
        assert.equal(taken?.needsHumanReason, null);
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the signature is invalid then should return error', async () => {
    const fixture = await createHttpFixture({ JARDINERO_AGENT_WEBHOOK_SECRET: 'whsecret' });
    try {
      const response = await fetch(`${fixture.baseUrl}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issue_comment',
          'x-hub-signature-256': 'sha256=deadbeef',
        },
        body: JSON.stringify({ action: 'created' }),
      });

      assert.equal(response.status, 401);
      assert.deepEqual(fixture.store.listSandboxRuns(1), []);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the action is not one we act on then should ignore the delivery', async () => {
    const fixture = await createHttpFixture({ JARDINERO_AGENT_WEBHOOK_SECRET: 'whsecret' });
    try {
      const body = JSON.stringify({
        action: 'opened',
        repository: { full_name: 'someone/else' },
        pull_request: { number: 1, draft: false, user: { login: 'guzmanpintos' } },
      });
      const response = await fetch(`${fixture.baseUrl}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-hub-signature-256': githubSignature('whsecret', body),
        },
        body,
      });

      assert.equal(response.status, 200);
      const json = (await response.json()) as { accepted: boolean; reason?: string };
      assert.equal(json.accepted, false);
      assert.equal(json.reason, 'pull_request_action_ignored');
      assert.deepEqual(fixture.store.listOpenPrMaintainers(), []);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the body is malformed then should return error', async () => {
    const fixture = await createHttpFixture({ JARDINERO_AGENT_WEBHOOK_SECRET: 'whsecret' });
    try {
      const body = 'not-json';
      const response = await fetch(`${fixture.baseUrl}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issue_comment',
          'x-hub-signature-256': githubSignature('whsecret', body),
        },
        body,
      });

      assert.equal(response.status, 400);
      const json = (await response.json()) as { error: string };
      assert.equal(json.error, 'invalid_json_body');
      assert.deepEqual(fixture.store.listSandboxRuns(1), []);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('POST /webhooks/linear', () => {
  test('When an issue is delegated then should queue and run an implementation', async () => {
    const fixture = await createHttpFixture(
      { LINEAR_WEBHOOK_SECRET: 'linsecret' },
      { linearEnabled: true },
    );
    try {
      const body = linearSessionBody('created');
      const response = await fetch(`${fixture.baseUrl}/webhooks/linear`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'linear-delivery': 'delivery-linear-1',
          'linear-signature': linearSignature('linsecret', body),
        },
        body,
      });

      assert.equal(response.status, 202);
      await eventually(() => {
        const instance = fixture.store.listOpenLinearImplementers().at(0);
        assert.equal(instance?.linearIssueIdentifier, 'JAR-7');
        assert.equal(instance?.linearSessionId, 'session-http-1');
        assert.equal(instance?.workflowState, 'li_implementing');
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test('When a delivery is redelivered then should drop it and keep one ticket', async () => {
    const fixture = await createHttpFixture(
      { LINEAR_WEBHOOK_SECRET: 'linsecret', LINEAR_APP_TOKEN: 'lt' },
      { linearEnabled: true },
    );
    try {
      const body = linearSessionBody('created');
      const post = (deliveryId: string) =>
        fetch(`${fixture.baseUrl}/webhooks/linear`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'linear-delivery': deliveryId,
            'linear-signature': linearSignature('linsecret', body),
          },
          body,
        });

      const first = await post('delivery-dup');
      assert.equal(first.status, 202);

      const replay = await post('delivery-dup');
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), { accepted: false, reason: 'duplicate_delivery' });

      const distinct = await post('delivery-new');
      assert.equal(distinct.status, 202);

      assert.equal(fixture.store.listOpenLinearImplementers().length, 1);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the signature is invalid then should return error', async () => {
    const fixture = await createHttpFixture(
      { LINEAR_WEBHOOK_SECRET: 'linsecret' },
      { linearEnabled: true },
    );
    try {
      const response = await fetch(`${fixture.baseUrl}/webhooks/linear`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'linear-signature': 'deadbeef' },
        body: linearSessionBody('created'),
      });

      assert.equal(response.status, 401);
      assert.deepEqual(fixture.store.listSandboxRuns(1), []);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the team maps project routes then should route with the project lookup', async () => {
    const graphqlQueries: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query?: string };
      graphqlQueries.push(request.query ?? '');
      if (request.query?.includes('IssueProject')) {
        return new Response(
          JSON.stringify({
            data: { issue: { project: { id: 'project-jardinero', name: 'Jardinero' } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            agentActivityCreate: { success: true },
            agentSessionUpdate: { success: true },
            markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const fixture = await createHttpFixture(
      { LINEAR_WEBHOOK_SECRET: 'linsecret', LINEAR_APP_TOKEN: 'lt' },
      {
        linearEnabled: true,
        fetchImpl,
        linearTeamRepos: {
          JAR: {
            default: 'acme/default',
            projects: { 'project-jardinero': 'acme/orchestrator' },
            repos: [],
          },
        },
      },
    );
    try {
      const body = linearSessionBody('created');
      const response = await fetch(`${fixture.baseUrl}/webhooks/linear`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'linear-signature': linearSignature('linsecret', body),
        },
        body,
      });

      assert.equal(response.status, 202);
      const instance = fixture.store.listOpenLinearImplementers().at(0);
      assert.ok(instance);
      assert.equal(
        fixture.store.getRepositoryById(instance.repositoryId)?.fullName,
        'acme/orchestrator',
      );
      assert.equal(graphqlQueries.filter((query) => query.includes('IssueProject')).length, 1);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the linear workflow is off then should report it disabled', async () => {
    const fixture = await createHttpFixture(
      { LINEAR_WEBHOOK_SECRET: 'linsecret' },
      { linearEnabled: false },
    );
    try {
      const body = linearSessionBody('created');
      const response = await fetch(`${fixture.baseUrl}/webhooks/linear`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'linear-signature': linearSignature('linsecret', body),
        },
        body,
      });

      assert.equal(response.status, 200);
      const json = (await response.json()) as { accepted: boolean; reason?: string };
      assert.equal(json.accepted, false);
      assert.equal(json.reason, 'linear_disabled');
      assert.deepEqual(fixture.store.listSandboxRuns(1), []);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the session is only prompted then should acknowledge without dispatching', async () => {
    const fixture = await createHttpFixture(
      { LINEAR_WEBHOOK_SECRET: 'linsecret' },
      { linearEnabled: true },
    );
    try {
      const body = linearSessionBody('prompted');
      const response = await fetch(`${fixture.baseUrl}/webhooks/linear`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'linear-signature': linearSignature('linsecret', body),
        },
        body,
      });

      assert.equal(response.status, 200);
      const json = (await response.json()) as { accepted: boolean; reason?: string };
      assert.equal(json.accepted, false);
      assert.equal(json.reason, 'prompted_not_supported');
      assert.deepEqual(fixture.store.listSandboxRuns(1), []);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the body is malformed then should return error', async () => {
    const fixture = await createHttpFixture(
      { LINEAR_WEBHOOK_SECRET: 'linsecret' },
      { linearEnabled: true },
    );
    try {
      const body = 'not-json';
      const response = await fetch(`${fixture.baseUrl}/webhooks/linear`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'linear-signature': linearSignature('linsecret', body),
        },
        body,
      });

      assert.equal(response.status, 400);
      const json = (await response.json()) as { error: string };
      assert.equal(json.error, 'invalid_json_body');
      assert.deepEqual(fixture.store.listSandboxRuns(1), []);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('POST /webhooks/discord', () => {
  test('When a ticket is asked for then should delegate it and answer in a thread', async () => {
    const discordCalls: DiscordCall[] = [];
    const interaction = signDiscordInteraction(
      discordCommandPayload({
        commandName: 'jardinero-ticket',
        options: [{ name: 'ticket', value: 'JAR-58' }],
      }),
    );
    const fixture = await createHttpFixture(
      {
        DISCORD_PUBLIC_KEY: interaction.publicKeyHex,
        DISCORD_APPLICATION_ID: 'application-1',
        DISCORD_BOT_TOKEN: 'bot-token',
        LINEAR_APP_TOKEN: 'linear-token',
      },
      {
        discordEnabled: true,
        discordAllowedRoleIds: ['role-1'],
        discordRepoChannels: { 'acme/widgets': 'channel-1' },
        people: [{ discordUserId: '1001', discordUsername: 'octo', linearUserId: 'linear-user-1' }],
        linearEnabled: true,
        fetchImpl: discordAndLinearStub(discordCalls),
      },
    );
    try {
      fixture.store.upsertRepository('acme/widgets');

      const response = await fetch(`${fixture.baseUrl}/webhooks/discord`, {
        method: 'POST',
        headers: interaction.headers,
        body: interaction.body,
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
      // The command starts nothing itself: it hands the ticket to us in Linear, and the
      // delivery Linear sends back is what opens the work.
      await eventually(() => {
        assert.deepEqual(
          discordCalls.filter((call) => call.mutation === 'DelegateIssue').map((call) => call.body),
          [{ id: 'issue-uuid', delegateId: 'app-user-1', assigneeId: 'linear-user-1' }],
        );
      });
      assert.deepEqual(fixture.store.listOpenLinearImplementers(), []);
      const request = fixture.store.listRequests({}, { limit: 10 }).rows.at(0);
      assert.equal(request?.requestSource, 'discord');
      assert.equal(request?.replyTargetId, 'thread-1');
      // The thread is the ticket's conversation, so whatever is announced later lands in it.
      assert.equal(
        fixture.store.findDiscordConversation('linear_issue:JAR-58')?.threadId,
        'thread-1',
      );
      assert.equal(discordCalls.filter((call) => call.url.endsWith('/threads')).length, 1);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When work is asked for in words then should write the ticket and delegate it', async () => {
    const discordCalls: DiscordCall[] = [];
    const interaction = signDiscordInteraction(
      discordCommandPayload({
        commandName: 'jardinero-code',
        options: [{ name: 'request', value: 'fix the typo in the miners tab' }],
      }),
    );
    const fixture = await createHttpFixture(
      {
        DISCORD_PUBLIC_KEY: interaction.publicKeyHex,
        DISCORD_APPLICATION_ID: 'application-1',
        DISCORD_BOT_TOKEN: 'bot-token',
        LINEAR_APP_TOKEN: 'linear-token',
      },
      {
        discordEnabled: true,
        discordAllowedRoleIds: ['role-1'],
        discordRepoChannels: { 'acme/widgets': 'channel-1' },
        linearEnabled: true,
        fetchImpl: discordAndLinearStub(discordCalls),
      },
    );
    try {
      fixture.store.upsertRepository('acme/widgets');

      const response = await fetch(`${fixture.baseUrl}/webhooks/discord`, {
        method: 'POST',
        headers: interaction.headers,
        body: interaction.body,
      });

      assert.equal(response.status, 200);
      // The words become a ticket in the team that numbers that repository, and that ticket
      // is delegated the same way one somebody wrote by hand would be.
      await eventually(() => {
        assert.deepEqual(
          discordCalls.filter((call) => call.mutation === 'CreateIssue').map((call) => call.body),
          [
            {
              input: {
                teamId: 'team-uuid',
                title: 'fix the typo in the miners tab',
                description: 'fix the typo in the miners tab',
              },
            },
          ],
        );
        assert.deepEqual(
          discordCalls.filter((call) => call.mutation === 'DelegateIssue').map((call) => call.body),
          [{ id: 'issue-uuid-79', delegateId: 'app-user-1' }],
        );
      });
      // The thread is filed under the ticket it turned out to be, so what the machines
      // announce later lands in it.
      await eventually(() =>
        assert.equal(
          fixture.store.findDiscordConversation('linear_issue:JAR-79')?.threadId,
          'thread-1',
        ),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the status is asked in a work thread then should answer what that work is doing', async () => {
    const discordCalls: DiscordCall[] = [];
    const interaction = signDiscordInteraction(
      discordCommandPayload({ commandName: 'jardinero-status', channelId: 'thread-1' }),
    );
    const fixture = await createHttpFixture(
      {
        DISCORD_PUBLIC_KEY: interaction.publicKeyHex,
        DISCORD_APPLICATION_ID: 'application-1',
        DISCORD_BOT_TOKEN: 'bot-token',
      },
      {
        discordEnabled: true,
        discordAllowedRoleIds: ['role-1'],
        fetchImpl: discordAndLinearStub(discordCalls),
      },
    );
    try {
      const repositoryId = fixture.store.upsertRepository('acme/widgets').id;
      const ticket = fixture.store.openLinearImplementer({
        repositoryId,
        linearIssueId: 'issue-uuid',
        linearIssueIdentifier: 'JAR-58',
      });
      fixture.store.setLinearImplementerState(ticket.id, 'li_verifying');
      fixture.store.saveDiscordConversation({
        conversationKey: 'linear_issue:JAR-58',
        threadId: 'thread-1',
      });

      const response = await fetch(`${fixture.baseUrl}/webhooks/discord`, {
        method: 'POST',
        headers: interaction.headers,
        body: interaction.body,
      });

      assert.equal(response.status, 200);
      await eventually(() =>
        assert.deepEqual(
          discordCalls
            .filter((call) => call.url.includes('/webhooks/application-1'))
            .map((call) => call.content),
          ['- JAR-58 is being verified'],
        ),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the channel refuses the thread then should answer instead of leaving it pending', async () => {
    const discordCalls: DiscordCall[] = [];
    const interaction = signDiscordInteraction(
      discordCommandPayload({
        commandName: 'jardinero-ticket',
        options: [{ name: 'ticket', value: 'JAR-58' }],
      }),
    );
    const fixture = await createHttpFixture(
      {
        DISCORD_PUBLIC_KEY: interaction.publicKeyHex,
        DISCORD_APPLICATION_ID: 'application-1',
        DISCORD_BOT_TOKEN: 'bot-token',
        LINEAR_APP_TOKEN: 'linear-token',
      },
      {
        discordEnabled: true,
        discordAllowedRoleIds: ['role-1'],
        discordRepoChannels: { 'acme/widgets': 'channel-1' },
        linearEnabled: true,
        fetchImpl: refusingChannelStub(discordCalls),
      },
    );
    try {
      fixture.store.upsertRepository('acme/widgets');

      const response = await fetch(`${fixture.baseUrl}/webhooks/discord`, {
        method: 'POST',
        headers: interaction.headers,
        body: interaction.body,
      });

      assert.equal(response.status, 200);
      await eventually(() =>
        assert.deepEqual(
          discordCalls
            .filter((call) => call.url.includes('/webhooks/application-1'))
            .map((call) => call.content),
          [
            'I cannot open a thread in this channel; an operator has to give Jardinero access to it.',
          ],
        ),
      );
      assert.deepEqual(fixture.store.listRequests({}, { limit: 10 }).rows, []);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the signature does not verify then should return error', async () => {
    const fixture = await createHttpFixture(
      { DISCORD_PUBLIC_KEY: 'ab'.repeat(32) },
      { discordEnabled: true, discordAllowedRoleIds: ['role-1'] },
    );
    try {
      const response = await fetch(`${fixture.baseUrl}/webhooks/discord`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 1 }),
      });

      assert.equal(response.status, 401);
    } finally {
      await fixture.cleanup();
    }
  });
});

// The Discord REST routes one command touches, over the Linear/GitHub GraphQL stub the
// fixture already installs.
function discordAndLinearStub(calls: DiscordCall[] = []): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const sent = graphqlOf(init?.body);
    calls.push({ url, content: contentOf(init?.body), ...sent });
    if (url.endsWith('/threads')) {
      return jsonBody({ id: 'thread-1' });
    }
    if (url.includes('discord.com/api')) {
      return url.includes('/messages') && !url.includes('/webhooks/')
        ? jsonBody({ id: 'message-1', channel_id: 'channel-1' })
        : new Response('', { status: 200 });
    }
    return jsonBody({
      data: {
        issues: {
          nodes:
            sent.mutation === 'IssueByIdentifier' && sent.body?.number === 58
              ? [{ id: 'issue-uuid', title: 'Add a hello' }]
              : [],
        },
        viewer: { id: 'app-user-1' },
        teams: { nodes: [{ id: 'team-uuid' }] },
        issueCreate: { success: true, issue: { id: 'issue-uuid-79', identifier: 'JAR-79' } },
        issueUpdate: { success: true },
        agentActivityCreate: { success: true },
        agentSessionUpdate: { success: true },
        markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
      },
    });
  };
}

interface DiscordCall {
  url: string;
  content?: string;
  mutation?: string;
  body?: Record<string, unknown>;
}

// The GraphQL operation a call carries, so a test can say which mutation was sent and with
// what, instead of matching on the query text.
function graphqlOf(
  body: RequestInit['body'],
): { mutation: string; body: Record<string, unknown> } | Record<string, never> {
  if (typeof body !== 'string') return {};
  const sent = JSON.parse(body) as { query?: string; variables?: Record<string, unknown> };
  const named = /(?:query|mutation)\s+(\w+)/.exec(sent.query ?? '');
  return named ? { mutation: named[1], body: sent.variables ?? {} } : {};
}

function contentOf(body: RequestInit['body']): string | undefined {
  if (typeof body !== 'string') return undefined;
  return (JSON.parse(body) as { content?: string }).content;
}

// A channel the bot has no access to, which is what Discord answers with 403.
function refusingChannelStub(calls: DiscordCall[]): typeof fetch {
  const answering = discordAndLinearStub(calls);
  return async (input, init) => {
    if (String(input).endsWith('/channels/channel-1/messages')) {
      return new Response('{"message":"Missing Access"}', { status: 403 });
    }
    return answering(input, init);
  };
}

function jsonBody(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
