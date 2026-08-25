import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { type AppConfig, loadConfig } from '../../config.js';
import { delegateLinearIssue, openLinearIssueForRequest } from './linear-delegation.js';

let config: AppConfig;
let sent: Array<{ mutation: string; variables: Record<string, unknown> }>;

beforeEach(() => {
  config = loadConfig();
  sent = [];
});

describe('delegateLinearIssue', () => {
  const cases: Array<{
    name: string;
    env?: NodeJS.ProcessEnv;
    issues?: unknown[];
    viewer?: { id: string };
    updated?: boolean;
    ownerLinearUserId?: string;
    linearIssueId?: string;
    wantError?: string;
    wantAsked: string[];
    wantDelegations: Array<{ id?: string; delegateId: string | null; assigneeId?: string }>;
  }> = [
    {
      name: 'When the ticket is not ours yet then should hand it to us',
      wantAsked: ['IssueByIdentifier', 'Viewer', 'DelegateIssue'],
      wantDelegations: [{ delegateId: 'app-user-1' }],
    },
    {
      // A ticket Linear has just written is not yet in the index a lookup by identifier
      // reads, so asking for it would answer nothing and the delegation would be refused.
      name: 'When the ticket was just written then should not ask Linear for it again',
      linearIssueId: 'issue-just-written',
      issues: [],
      wantAsked: ['Viewer', 'DelegateIssue'],
      wantDelegations: [{ id: 'issue-just-written', delegateId: 'app-user-1' }],
    },
    {
      // Delegating in Linear makes the person who did it the owner, and a ticket delegated
      // from Discord has to end up looking the same.
      name: 'When nobody owns the ticket then should make whoever asked its owner',
      ownerLinearUserId: 'linear-user-1',
      wantAsked: ['IssueByIdentifier', 'Viewer', 'DelegateIssue'],
      wantDelegations: [{ delegateId: 'app-user-1', assigneeId: 'linear-user-1' }],
    },
    {
      // Saying nothing about the owner is what leaves them alone; sending null takes the
      // ticket away from them.
      name: 'When somebody already owns the ticket then should say nothing about the owner',
      issues: [{ id: 'issue-uuid', title: 'Add a hello', assignee: { id: 'someone-else' } }],
      ownerLinearUserId: 'linear-user-1',
      wantAsked: ['IssueByIdentifier', 'Viewer', 'DelegateIssue'],
      wantDelegations: [{ delegateId: 'app-user-1' }],
    },
    {
      // Delegating what is already delegated is not a delegation, so Linear would open no
      // session and the work would never start.
      name: 'When the ticket is already ours then should hand it back before taking it again',
      issues: [{ id: 'issue-uuid', title: 'Add a hello', delegate: { id: 'app-user-1' } }],
      wantAsked: ['IssueByIdentifier', 'Viewer', 'DelegateIssue', 'DelegateIssue'],
      wantDelegations: [{ delegateId: null }, { delegateId: 'app-user-1' }],
    },
    {
      name: 'When the ticket cannot be handed back then should return error',
      issues: [{ id: 'issue-uuid', title: 'Add a hello', delegate: { id: 'app-user-1' } }],
      updated: false,
      wantError: 'linear refused to hand JAR-58 back before delegating',
      wantAsked: ['IssueByIdentifier', 'Viewer', 'DelegateIssue'],
      wantDelegations: [{ delegateId: null }],
    },
    {
      name: 'When somebody else is acting on the ticket then should take it from them',
      issues: [{ id: 'issue-uuid', title: 'Add a hello', delegate: { id: 'someone-else' } }],
      wantAsked: ['IssueByIdentifier', 'Viewer', 'DelegateIssue'],
      wantDelegations: [{ delegateId: 'app-user-1' }],
    },
    {
      name: 'When the token is unset then should return error',
      env: {},
      wantError: 'the linear api token is unset',
      wantAsked: [],
      wantDelegations: [],
    },
    {
      name: 'When Linear knows no such ticket then should return error',
      issues: [],
      wantError: 'JAR-58 is not a ticket Linear knows',
      wantAsked: ['IssueByIdentifier'],
      wantDelegations: [],
    },
    {
      name: 'When Linear does not say who we are then should return error',
      viewer: undefined,
      wantError: 'linear does not say who we are',
      wantAsked: ['IssueByIdentifier', 'Viewer'],
      wantDelegations: [],
    },
    {
      name: 'When the delegation is refused then should return error',
      updated: false,
      wantError: 'linear refused to delegate JAR-58',
      wantAsked: ['IssueByIdentifier', 'Viewer', 'DelegateIssue'],
      wantDelegations: [{ delegateId: 'app-user-1' }],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const error = await delegateLinearIssue(
        {
          config,
          env: testCase.env ?? { [config.workflows.linearImplementer.apiTokenEnv]: 'token' },
          fetchImpl: linearStub(testCase),
        },
        {
          identifier: 'JAR-58',
          ...(testCase.linearIssueId ? { linearIssueId: testCase.linearIssueId } : {}),
        },
        testCase.ownerLinearUserId,
      );

      assert.equal(error?.message, testCase.wantError);
      assert.deepEqual(
        sent.map((call) => call.mutation),
        testCase.wantAsked,
      );
      assert.deepEqual(
        sent.filter((call) => call.mutation === 'DelegateIssue').map((call) => call.variables),
        testCase.wantDelegations.map((delegation) => ({ id: 'issue-uuid', ...delegation })),
      );
    });
  }
});

describe('openLinearIssueForRequest', () => {
  const cases: Array<{
    name: string;
    env?: NodeJS.ProcessEnv;
    teams?: unknown[];
    issueCreate?: unknown;
    updated?: boolean;
    want: { identifier?: string; error?: string };
    wantWritten?: Record<string, unknown>;
  }> = [
    {
      // A ticket needs a title and a person wrote prose, so the first line is the title and
      // the whole text stays as the description.
      name: 'When the words become a ticket then should answer what it is called',
      want: { identifier: 'JAR-79' },
      wantWritten: {
        teamId: 'team-uuid',
        title: 'fix the typo in the miners tab',
        description: 'fix the typo in the miners tab\n\nit says commmander with three m',
      },
    },
    {
      name: 'When the token is unset then should return error without writing anything',
      env: {},
      want: { error: 'the linear api token is unset' },
    },
    {
      name: 'When no team carries that key then should return error',
      teams: [],
      want: { error: 'linear refused to open a ticket in JAR' },
    },
    {
      name: 'When Linear refuses to write it then should return error',
      issueCreate: { success: false },
      want: { error: 'linear refused to open a ticket in JAR' },
      wantWritten: {
        teamId: 'team-uuid',
        title: 'fix the typo in the miners tab',
        description: 'fix the typo in the miners tab\n\nit says commmander with three m',
      },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const answered = await openLinearIssueForRequest(
        {
          config,
          env: testCase.env ?? { [config.workflows.linearImplementer.apiTokenEnv]: 'token' },
          fetchImpl: linearStub({
            issues: [{ id: 'issue-uuid', title: 'fix the typo in the miners tab' }],
            teams: testCase.teams,
            issueCreate: testCase.issueCreate,
            updated: testCase.updated,
          }),
        },
        {
          teamKey: 'JAR',
          text: 'fix the typo in the miners tab\n\nit says commmander with three m',
        },
      );

      if (testCase.want.identifier) {
        assert.deepEqual(answered, {
          identifier: testCase.want.identifier,
          linearIssueId: 'issue-uuid',
        });
      } else {
        assert.equal((answered as Error).message, testCase.want.error);
      }
      assert.deepEqual(
        sent.find((call) => call.mutation === 'CreateIssue')?.variables.input,
        testCase.wantWritten,
      );
    });
  }
});

function linearStub(answers: {
  issues?: unknown[];
  viewer?: { id: string };
  updated?: boolean;
  teams?: unknown[];
  issueCreate?: unknown;
}): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const named = /(?:query|mutation)\s+(\w+)/.exec(body.query);
    sent.push({ mutation: named?.[1] ?? '', variables: body.variables });
    return new Response(
      JSON.stringify({
        data: {
          issues: { nodes: answers.issues ?? [{ id: 'issue-uuid', title: 'Add a hello' }] },
          viewer: 'viewer' in answers ? answers.viewer : { id: 'app-user-1' },
          teams: { nodes: answers.teams ?? [{ id: 'team-uuid' }] },
          issueCreate: answers.issueCreate ?? {
            success: true,
            issue: { id: 'issue-uuid', identifier: 'JAR-79' },
          },
          issueUpdate: { success: answers.updated ?? true },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}
