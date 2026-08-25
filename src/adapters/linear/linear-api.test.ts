import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createAgentActivity,
  createIssue,
  delegateIssue,
  getAppUserId,
  getIssue,
  getIssueProject,
} from './linear-api.js';

describe('createAgentActivity', () => {
  test('When an activity is created then should post the session id and content', async () => {
    const capture: { body?: unknown } = {};
    await createAgentActivity({
      sessionId: 'session-1',
      content: { type: 'thought', body: 'Picked up JAR-42.' },
      token: 'token',
      fetchImpl: fetchStub(
        200,
        JSON.stringify({ data: { agentActivityCreate: { success: true } } }),
        capture,
      ),
    });

    const request = capture.body as { query: string; variables: Record<string, unknown> };
    assert.match(request.query, /agentActivityCreate/);
    assert.deepEqual(request.variables.input, {
      agentSessionId: 'session-1',
      content: { type: 'thought', body: 'Picked up JAR-42.' },
    });
  });

  const failureCases = [
    {
      name: 'When http status is not ok then should return error',
      status: 500,
      body: 'server exploded',
      message: /Linear GraphQL request failed: 500/,
    },
    {
      name: 'When response is not json then should return error',
      status: 200,
      body: 'not-json',
      message: /invalid JSON/,
    },
    {
      name: 'When response carries graphql errors then should return error',
      status: 200,
      body: JSON.stringify({ errors: [{ message: 'not authorized' }] }),
      message: /Linear GraphQL errors/,
    },
    {
      name: 'When response has no data then should return error',
      status: 200,
      body: JSON.stringify({}),
      message: /missing data/,
    },
    {
      name: 'When mutation reports no success then should return error',
      status: 200,
      body: JSON.stringify({ data: { agentActivityCreate: { success: false } } }),
      message: /did not report success/,
    },
  ];

  for (const c of failureCases) {
    test(c.name, async () => {
      await assert.rejects(
        createAgentActivity({
          sessionId: 'session-1',
          content: { type: 'thought', body: 'x' },
          token: 'token',
          fetchImpl: fetchStub(c.status, c.body),
        }),
        c.message,
      );
    });
  }
});

describe('getIssueProject', () => {
  test('When issue has project then should return project', async () => {
    const capture: { body?: unknown } = {};
    const project = await getIssueProject({
      issueId: 'issue-1',
      token: 'token',
      fetchImpl: fetchStub(
        200,
        JSON.stringify({ data: { issue: { project: { id: 'project-1', name: 'Jardinero' } } } }),
        capture,
      ),
    });

    assert.deepEqual(project, { id: 'project-1', name: 'Jardinero' });
    const request = capture.body as { query: string; variables: Record<string, unknown> };
    assert.match(request.query, /IssueProject/);
    assert.equal(request.variables.id, 'issue-1');
  });

  test('When issue has no project then should return undefined', async () => {
    const project = await getIssueProject({
      issueId: 'issue-1',
      token: 'token',
      fetchImpl: fetchStub(200, JSON.stringify({ data: { issue: { project: null } } })),
    });

    assert.equal(project, undefined);
  });
});

describe('getIssue', () => {
  const cases: Array<{
    name: string;
    identifier: string;
    nodes?: unknown[];
    answered?: unknown;
    wantIssue?: { linearIssueId: string; title: string; description?: string };
  }> = [
    {
      name: 'When the ticket exists then should read its id and text',
      identifier: 'SYS-1191',
      nodes: [{ id: 'issue-uuid', title: 'Add a hello', description: 'one line in the README' }],
      wantIssue: {
        linearIssueId: 'issue-uuid',
        title: 'Add a hello',
        description: 'one line in the README',
      },
    },
    {
      name: 'When the ticket has no description then should read only its title',
      identifier: 'SYS-1191',
      nodes: [{ id: 'issue-uuid', title: 'Add a hello', description: '   ' }],
      wantIssue: { linearIssueId: 'issue-uuid', title: 'Add a hello' },
    },
    {
      name: 'When no ticket matches then should answer nothing',
      identifier: 'SYS-1191',
      nodes: [],
      wantIssue: undefined,
    },
    {
      name: 'When the answer carries no title then should answer nothing',
      identifier: 'SYS-1191',
      nodes: [{ id: 'issue-uuid' }],
      wantIssue: undefined,
    },
    {
      name: 'When the answer carries no issues at all then should answer nothing',
      identifier: 'SYS-1191',
      answered: {},
      wantIssue: undefined,
    },
    {
      name: 'When the identifier carries no number then should answer nothing without asking',
      identifier: 'SYS',
      wantIssue: undefined,
    },
    {
      name: 'When the number is not a number then should answer nothing without asking',
      identifier: 'SYS-eleven',
      wantIssue: undefined,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const capture: { body?: unknown } = {};
      const issue = await getIssue({
        identifier: testCase.identifier,
        token: 'token',
        fetchImpl: fetchStub(
          200,
          JSON.stringify({
            data: testCase.answered ?? { issues: { nodes: testCase.nodes ?? [] } },
          }),
          capture,
        ),
      });

      assert.deepEqual(issue, testCase.wantIssue);
    });
  }

  test('When the ticket is asked for then should look it up by team key and number', async () => {
    const capture: { body?: unknown } = {};
    await getIssue({
      identifier: 'sys-1191',
      token: 'token',
      fetchImpl: fetchStub(200, JSON.stringify({ data: { issues: { nodes: [] } } }), capture),
    });

    const request = capture.body as { query: string; variables: Record<string, unknown> };
    assert.match(request.query, /IssueByIdentifier/);
    assert.equal(request.variables.teamKey, 'SYS');
    assert.equal(request.variables.number, 1191);
  });
});

describe('createIssue', () => {
  const cases: Array<{
    name: string;
    teams?: unknown[];
    issueCreate?: unknown;
    title?: string;
    wantCreated?: { linearIssueId: string; identifier: string };
    wantSent?: Record<string, unknown>;
  }> = [
    {
      name: 'When the team is known then should write the ticket in it',
      wantCreated: { linearIssueId: 'issue-uuid', identifier: 'JAR-79' },
      wantSent: { teamId: 'team-uuid', title: 'fix the typo', description: 'fix the typo' },
    },
    {
      // A ticket needs a title and a person wrote prose, so the caller decides the title and
      // the whole text stays as the description.
      name: 'When the text runs long then should still send both as they were given',
      title: 'the first line of what somebody wrote',
      wantCreated: { linearIssueId: 'issue-uuid', identifier: 'JAR-79' },
      wantSent: {
        teamId: 'team-uuid',
        title: 'the first line of what somebody wrote',
        description: 'fix the typo',
      },
    },
    {
      name: 'When no team carries that key then should answer nothing without writing',
      teams: [],
      wantCreated: undefined,
    },
    {
      name: 'When Linear refuses to write it then should answer nothing',
      issueCreate: { success: false },
      wantCreated: undefined,
      wantSent: { teamId: 'team-uuid', title: 'fix the typo', description: 'fix the typo' },
    },
    {
      name: 'When the answer carries no ticket then should answer nothing',
      issueCreate: { success: true },
      wantCreated: undefined,
      wantSent: { teamId: 'team-uuid', title: 'fix the typo', description: 'fix the typo' },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const sent: Array<{ mutation: string; variables: Record<string, unknown> }> = [];
      const created = await createIssue({
        teamKey: 'jar',
        title: testCase.title ?? 'fix the typo',
        description: 'fix the typo',
        token: 'token',
        fetchImpl: recordingStub(sent, {
          teams: { nodes: testCase.teams ?? [{ id: 'team-uuid' }] },
          issueCreate: testCase.issueCreate ?? {
            success: true,
            issue: { id: 'issue-uuid', identifier: 'JAR-79' },
          },
        }),
      });

      assert.deepEqual(created, testCase.wantCreated);
      assert.deepEqual(
        sent.find((call) => call.mutation === 'CreateIssue')?.variables.input,
        testCase.wantSent,
      );
    });
  }

  test('When the ticket is written then should look the team up by its key in upper case', async () => {
    const sent: Array<{ mutation: string; variables: Record<string, unknown> }> = [];
    await createIssue({
      teamKey: 'jar',
      title: 'fix the typo',
      description: 'fix the typo',
      token: 'token',
      fetchImpl: recordingStub(sent, {
        teams: { nodes: [{ id: 'team-uuid' }] },
        issueCreate: { success: true, issue: { id: 'issue-uuid', identifier: 'JAR-79' } },
      }),
    });

    assert.deepEqual(sent.find((call) => call.mutation === 'TeamByKey')?.variables, { key: 'JAR' });
  });
});

describe('getAppUserId', () => {
  const cases: Array<{ name: string; viewer?: unknown; wantId?: string }> = [
    {
      name: 'When Linear answers who we are then should read our id',
      viewer: { id: 'app-user-1' },
      wantId: 'app-user-1',
    },
    {
      name: 'When the answer carries no viewer then should answer nothing',
      viewer: undefined,
      wantId: undefined,
    },
    {
      name: 'When the viewer carries no id then should answer nothing',
      viewer: {},
      wantId: undefined,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const id = await getAppUserId({
        token: 'token',
        fetchImpl: fetchStub(200, JSON.stringify({ data: { viewer: testCase.viewer } })),
      });

      assert.equal(id, testCase.wantId);
    });
  }
});

describe('delegateIssue', () => {
  const cases: Array<{
    name: string;
    delegateId: string | null;
    assigneeId?: string;
    issueUpdate?: unknown;
    wantDelegated: boolean;
  }> = [
    {
      // Sent as null it would take the ticket away from whoever owns it, so an owner we are
      // not setting is left out of the mutation.
      name: 'When no owner is given then should delegate it and say nothing about the owner',
      delegateId: 'app-user-1',
      issueUpdate: { success: true },
      wantDelegated: true,
    },
    {
      // A ticket delegated in Linear stays its owner's, so the owner travels with it.
      name: 'When the ticket is given an owner then should send both',
      delegateId: 'app-user-1',
      assigneeId: 'linear-user-1',
      issueUpdate: { success: true },
      wantDelegated: true,
    },
    {
      name: 'When the ticket is handed back to nobody then should say it was delegated',
      delegateId: null,
      issueUpdate: { success: true },
      wantDelegated: true,
    },
    {
      name: 'When Linear refuses then should say it was not delegated',
      delegateId: 'app-user-1',
      issueUpdate: { success: false },
      wantDelegated: false,
    },
    {
      name: 'When the answer carries no update then should say it was not delegated',
      delegateId: 'app-user-1',
      issueUpdate: undefined,
      wantDelegated: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const capture: { body?: unknown } = {};
      const delegated = await delegateIssue({
        issueId: 'issue-uuid',
        delegateId: testCase.delegateId,
        ...(testCase.assigneeId ? { assigneeId: testCase.assigneeId } : {}),
        token: 'token',
        fetchImpl: fetchStub(
          200,
          JSON.stringify({ data: { issueUpdate: testCase.issueUpdate } }),
          capture,
        ),
      });

      assert.equal(delegated, testCase.wantDelegated);
      assert.deepEqual((capture.body as { variables: unknown }).variables, {
        id: 'issue-uuid',
        delegateId: testCase.delegateId,
        ...(testCase.assigneeId ? { assigneeId: testCase.assigneeId } : {}),
      });
    });
  }
});

function fetchStub(status: number, body: string, capture?: { body?: unknown }): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    if (capture && typeof init?.body === 'string') capture.body = JSON.parse(init.body);
    return new Response(body, { status });
  }) as typeof fetch;
}

// The calls a mutation chain makes, so a case can say what was sent and in what order.
function recordingStub(
  sent: Array<{ mutation: string; variables: Record<string, unknown> }>,
  data: Record<string, unknown>,
): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const named = /(?:query|mutation)\s+(\w+)/.exec(body.query);
    sent.push({ mutation: named?.[1] ?? '', variables: body.variables });
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}
