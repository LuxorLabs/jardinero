import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  getPullRequestHead,
  getPullRequestState,
  type OpenPullRequest,
  listOpenPullRequests,
  markPullRequestReadyForReview,
} from './github-pull-requests.js';

const REPO = 'acme/webapp';
const PR_NUMBER = 42;

describe('getPullRequestHead', () => {
  test('When the pr is a draft then should return its node id, draft flag and head ref', async () => {
    const calls: string[] = [];

    const head = await getPullRequestHead({
      repo: REPO,
      pullRequestNumber: PR_NUMBER,
      token: 'token',
      fetchImpl: recordingFetch(calls, prBody({ draft: true })),
    });

    assert.deepEqual(head, { nodeId: 'PR_node', draft: true, headRef: 'agent/branch' });
    assert.deepEqual(calls, ['https://api.github.com/repos/acme/webapp/pulls/42']);
  });

  const headCases: Array<{ name: string; body: Record<string, unknown>; wantDraft: boolean }> = [
    {
      name: 'When the pr is not a draft then should report it ready',
      body: prBody({ draft: false }),
      wantDraft: false,
    },
    {
      // Anything other than a literal true is read as not-draft, so a missing or
      // string-typed flag never makes the coordinator try to flip it again.
      name: 'When the draft flag is absent then should report it ready',
      body: { node_id: 'PR_node', head: { ref: 'agent/branch' } },
      wantDraft: false,
    },
    {
      name: 'When the draft flag is a string then should report it ready',
      body: { node_id: 'PR_node', draft: 'true', head: { ref: 'agent/branch' } },
      wantDraft: false,
    },
  ];

  for (const testCase of headCases) {
    test(testCase.name, async () => {
      const head = await getPullRequestHead({
        repo: REPO,
        pullRequestNumber: PR_NUMBER,
        token: 'token',
        fetchImpl: jsonFetch(testCase.body),
      });

      assert.equal(head.draft, testCase.wantDraft);
    });
  }

  test('When the head ref has padding then should trim it', async () => {
    const head = await getPullRequestHead({
      repo: REPO,
      pullRequestNumber: PR_NUMBER,
      token: 'token',
      fetchImpl: jsonFetch({ node_id: 'PR_node', head: { ref: '  agent/branch  ' } }),
    });

    assert.equal(head.headRef, 'agent/branch');
  });

  // Every failure has to name the PR and the reason: the caller treats these as
  // best effort and the message is what lands in the audit row.
  const failureCases: Array<{
    name: string;
    response?: () => Response;
    wantError: RegExp;
  }> = [
    {
      name: 'When github answers with an error status then should return error with the body',
      response: () => new Response('nope', { status: 404 }),
      wantError: /lookup for acme\/webapp#42 failed with HTTP 404: nope/,
    },
    {
      name: 'When the body is not json then should return error',
      response: () => new Response('{not json', { status: 200 }),
      wantError: /returned invalid JSON/,
    },
    {
      name: 'When the body is not an object then should return error',
      response: () => new Response('[1,2]', { status: 200 }),
      wantError: /returned a non-object response/,
    },
    {
      name: 'When the node id is missing then should return error',
      response: () => jsonResponse({ head: { ref: 'agent/branch' } }),
      wantError: /returned no node id/,
    },
    {
      name: 'When the node id is empty then should return error',
      response: () => jsonResponse({ node_id: '', head: { ref: 'agent/branch' } }),
      wantError: /returned no node id/,
    },
    {
      name: 'When the head is missing then should return error',
      response: () => jsonResponse({ node_id: 'PR_node' }),
      wantError: /returned no head ref/,
    },
    {
      name: 'When the head ref is blank then should return error',
      response: () => jsonResponse({ node_id: 'PR_node', head: { ref: '   ' } }),
      wantError: /returned no head ref/,
    },
  ];

  for (const testCase of failureCases) {
    test(testCase.name, async () => {
      await assert.rejects(
        () =>
          getPullRequestHead({
            repo: REPO,
            pullRequestNumber: PR_NUMBER,
            token: 'token',
            fetchImpl: (async () =>
              testCase.response?.() ?? jsonResponse({})) as unknown as typeof fetch,
          }),
        testCase.wantError,
      );
    });
  }

  test('When the body is huge then should truncate it in the error', async () => {
    await assert.rejects(
      () =>
        getPullRequestHead({
          repo: REPO,
          pullRequestNumber: PR_NUMBER,
          token: 'token',
          fetchImpl: (async () =>
            new Response('x'.repeat(500), { status: 500 })) as unknown as typeof fetch,
        }),
      (error: Error) => error.message.includes('...') && error.message.length < 420,
    );
  });
});

describe('markPullRequestReadyForReview', () => {
  test('When the pr is a draft then should post the mutation with its node id', async () => {
    const bodies: string[] = [];

    await markPullRequestReadyForReview({
      repo: REPO,
      pullRequestNumber: PR_NUMBER,
      token: 'token',
      fetchImpl: mutationFetch(bodies, { draft: true }, () =>
        jsonResponse({
          data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
        }),
      ),
    });

    assert.equal(bodies.length, 1);
    const sent = JSON.parse(bodies[0]) as { variables: { id: string } };
    assert.equal(sent.variables.id, 'PR_node');
  });

  // The mutation rejects a PR that is not a draft, so a second call has to be a
  // no-op rather than an error the caller has to swallow.
  test('When the pr is already ready then should not call the mutation', async () => {
    const bodies: string[] = [];

    await markPullRequestReadyForReview({
      repo: REPO,
      pullRequestNumber: PR_NUMBER,
      token: 'token',
      fetchImpl: mutationFetch(bodies, { draft: false }, () => jsonResponse({ data: {} })),
    });

    assert.deepEqual(bodies, []);
  });

  const failureCases: Array<{ name: string; response: () => Response; wantError: RegExp }> = [
    {
      name: 'When the mutation answers with an error status then should return error',
      response: () => new Response('boom', { status: 502 }),
      wantError: /mark-ready mutation failed with HTTP 502: boom/,
    },
    {
      name: 'When the mutation body is not json then should return error',
      response: () => new Response('{not json', { status: 200 }),
      wantError: /mark-ready mutation returned invalid JSON/,
    },
    {
      name: 'When the mutation body is not an object then should return error',
      response: () => new Response('[]', { status: 200 }),
      wantError: /mark-ready mutation returned a non-object response/,
    },
    {
      // GraphQL answers 200 with an errors array, so the status alone never proves
      // the PR was flipped.
      name: 'When the mutation reports graphql errors then should return error',
      response: () => jsonResponse({ errors: [{ message: 'not a draft' }] }),
      wantError: /mark-ready mutation errors: .*not a draft/,
    },
    {
      name: 'When the mutation response has no data then should return error',
      response: () => jsonResponse({ extensions: {} }),
      wantError: /mark-ready mutation response is missing data/,
    },
  ];

  for (const testCase of failureCases) {
    test(testCase.name, async () => {
      await assert.rejects(
        () =>
          markPullRequestReadyForReview({
            repo: REPO,
            pullRequestNumber: PR_NUMBER,
            token: 'token',
            fetchImpl: mutationFetch([], { draft: true }, testCase.response),
          }),
        testCase.wantError,
      );
    });
  }

  test('When an empty errors array comes back then should treat it as success', async () => {
    await markPullRequestReadyForReview({
      repo: REPO,
      pullRequestNumber: PR_NUMBER,
      token: 'token',
      fetchImpl: mutationFetch([], { draft: true }, () => jsonResponse({ errors: [], data: {} })),
    });
  });
});

describe('getPullRequestState', () => {
  const cases: StateCase[] = [
    {
      name: 'When the pull request is open with green checks then should answer so',
      body: pullRequestNode(),
      want: { state: 'open', headCommitSha: 'sha-1', checksAreRed: false, unresolved: false },
    },
    {
      name: 'When the pull request was merged then should answer merged',
      body: pullRequestNode({ merged: true }),
      want: { state: 'merged', headCommitSha: 'sha-1', checksAreRed: false, unresolved: false },
    },
    {
      name: 'When the pull request was closed then should answer closed',
      body: pullRequestNode({ state: 'CLOSED' }),
      want: { state: 'closed', headCommitSha: 'sha-1', checksAreRed: false, unresolved: false },
    },
    {
      // Absent, the checks read as green, which is the answer that lets a pass through.
      name: 'When the answer carries no commit then should answer the checks are not red',
      body: pullRequestNode({ withoutCommits: true }),
      want: { state: 'open', headCommitSha: 'sha-1', checksAreRed: false, unresolved: false },
    },
    {
      name: 'When the answer carries no review threads then should answer there is none',
      body: pullRequestNode({ withoutReviewThreads: true }),
      want: { state: 'open', headCommitSha: 'sha-1', checksAreRed: false, unresolved: false },
    },
    {
      name: 'When the rollup failed then should answer the checks are red',
      body: pullRequestNode({ rollup: 'FAILURE' }),
      want: { state: 'open', headCommitSha: 'sha-1', checksAreRed: true, unresolved: false },
    },
    {
      name: 'When a review thread is unresolved then should answer so',
      body: pullRequestNode({ threads: [{ isResolved: false, isOutdated: false }] }),
      want: { state: 'open', headCommitSha: 'sha-1', checksAreRed: false, unresolved: true },
    },
    {
      // An outdated thread is about code that is no longer there.
      name: 'When the unresolved thread is outdated then should answer there is none',
      body: pullRequestNode({ threads: [{ isResolved: false, isOutdated: true }] }),
      want: { state: 'open', headCommitSha: 'sha-1', checksAreRed: false, unresolved: false },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const state = await getPullRequestState({
        repo: REPO,
        pullRequestNumber: PR_NUMBER,
        token: 'gh_token',
        fetchImpl: answering(() => jsonResponse(c.body)),
      });

      assert.equal(state.state, c.want.state);
      assert.equal(state.headCommitSha, c.want.headCommitSha);
      assert.equal(state.checksAreRed, c.want.checksAreRed);
      assert.equal(state.hasUnresolvedReviewThreads, c.want.unresolved);
    });
  }

  const failureCases: StateFailureCase[] = [
    {
      name: 'When the repository name is malformed then should return error',
      repo: 'not-a-repo',
      wantError: /Invalid GitHub repository name/,
    },
    {
      name: 'When github answers with an error status then should return error',
      answer: () => new Response('nope', { status: 500 }),
      wantError: /GitHub GraphQL request failed: 500/,
    },
    {
      name: 'When the answer carries graphql errors then should return error',
      answer: () => jsonResponse({ errors: [{ message: 'boom' }] }),
      wantError: /GitHub GraphQL errors/,
    },
    {
      name: 'When the pull request is absent then should return error',
      answer: () => jsonResponse({ data: { repository: {} } }),
      wantError: /returned no pull request/,
    },
    {
      name: 'When the head sha is absent then should return error',
      answer: () => jsonResponse(pullRequestNode({ headRefOid: '' })),
      wantError: /returned no head sha/,
    },
  ];

  for (const c of failureCases) {
    test(c.name, async () => {
      await assert.rejects(
        getPullRequestState({
          repo: c.repo ?? REPO,
          pullRequestNumber: PR_NUMBER,
          token: 'gh_token',
          fetchImpl: answering(c.answer ?? (() => jsonResponse(pullRequestNode()))),
        }),
        c.wantError,
      );
    });
  }
});

describe('listOpenPullRequests', () => {
  const cases: ListCase[] = [
    {
      name: 'When a pull request is listed then should answer its number and branch',
      items: [{ number: 1, head: { ref: 'agent/jar-58' } }],
      want: [{ pullRequestNumber: 1, headBranch: 'agent/jar-58', isDraft: false }],
    },
    {
      // Whether a draft is ours to touch is the machine's call, so it travels as a fact.
      name: 'When a pull request is a draft then should say so',
      items: [{ number: 4, draft: true, head: { ref: 'agent/jar-58' } }],
      want: [{ pullRequestNumber: 4, headBranch: 'agent/jar-58', isDraft: true }],
    },
    {
      name: 'When an entry carries no head then should answer no branch',
      items: [{ number: 6 }],
      want: [{ pullRequestNumber: 6, headBranch: undefined, isDraft: false }],
    },
    {
      name: 'When a listed entry has no number then should leave it out',
      items: [{ head: { ref: 'agent/jar-58' } }],
      want: [],
    },
    {
      name: 'When an entry carries a title and a body then should answer them',
      items: [{ number: 7, head: { ref: 'agent/jar-58' }, title: 'fix: x', body: 'why x' }],
      want: [
        {
          pullRequestNumber: 7,
          headBranch: 'agent/jar-58',
          isDraft: false,
          title: 'fix: x',
          body: 'why x',
        },
      ],
    },
    {
      name: 'When the body is null then should leave it out',
      items: [{ number: 8, head: { ref: 'agent/jar-58' }, title: 'fix: x', body: null }],
      want: [{ pullRequestNumber: 8, headBranch: 'agent/jar-58', isDraft: false, title: 'fix: x' }],
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const open = await listOpenPullRequests({
        repo: REPO,
        token: 'gh_token',
        fetchImpl: answering(() => jsonResponse(c.items)),
      });

      assert.deepEqual(open, c.want);
    });
  }

  test('When a page is full then should ask for the next one', async () => {
    const pages: string[] = [];
    const open = await listOpenPullRequests({
      repo: REPO,
      token: 'gh_token',
      fetchImpl: ((url: string) => {
        pages.push(new URL(url).searchParams.get('page') ?? '');
        const full = pages.length === 1;
        return Promise.resolve(
          jsonResponse(
            full
              ? Array.from({ length: 100 }, (_, index) => ({
                  number: index + 1,
                  head: { ref: 'agent/x' },
                }))
              : [{ number: 999, head: { ref: 'agent/x' } }],
          ),
        );
      }) as unknown as typeof fetch,
    });

    assert.deepEqual(pages, ['1', '2']);
    assert.equal(open.length, 101);
  });

  test('When github refuses the list then should return error', async () => {
    await assert.rejects(
      listOpenPullRequests({
        repo: REPO,
        token: 'gh_token',
        fetchImpl: answering(() => new Response('nope', { status: 403 })),
      }),
      /failed with HTTP 403/,
    );
  });
});

function prBody(options: { draft: boolean }): Record<string, unknown> {
  return { node_id: 'PR_node', draft: options.draft, head: { ref: 'agent/branch' } };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonFetch(body: unknown): typeof fetch {
  return (async () => jsonResponse(body)) as unknown as typeof fetch;
}

function recordingFetch(calls: string[], body: unknown): typeof fetch {
  return (async (input: unknown) => {
    calls.push(String(input));
    return jsonResponse(body);
  }) as unknown as typeof fetch;
}

// The lookup always runs first; the mutation only when the PR is still a draft.
function mutationFetch(
  bodies: string[],
  head: { draft: boolean },
  mutation: () => Response,
): typeof fetch {
  return (async (input: unknown, init?: { body?: string }) => {
    if (String(input).includes('/graphql')) {
      bodies.push(init?.body ?? '');
      return mutation();
    }
    return jsonResponse(prBody(head));
  }) as unknown as typeof fetch;
}

function answering(answer: () => Response): typeof fetch {
  return (() => Promise.resolve(answer())) as unknown as typeof fetch;
}

function pullRequestNode(
  overrides: {
    state?: string;
    merged?: boolean;
    headRefOid?: string;
    rollup?: string;
    threads?: unknown[];
    withoutCommits?: boolean;
    withoutReviewThreads?: boolean;
  } = {},
): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          state: overrides.state ?? 'OPEN',
          merged: overrides.merged ?? false,
          headRefOid: overrides.headRefOid ?? 'sha-1',
          ...(overrides.withoutCommits
            ? {}
            : {
                commits: {
                  nodes: [
                    { commit: { statusCheckRollup: { state: overrides.rollup ?? 'SUCCESS' } } },
                  ],
                },
              }),
          ...(overrides.withoutReviewThreads
            ? {}
            : { reviewThreads: { nodes: overrides.threads ?? [] } }),
        },
      },
    },
  };
}

interface StateCase {
  name: string;
  body: unknown;
  want: { state: string; headCommitSha: string; checksAreRed: boolean; unresolved: boolean };
}

interface StateFailureCase {
  name: string;
  repo?: string;
  answer?: () => Response;
  wantError: RegExp;
}

interface ListCase {
  name: string;
  items: Array<Record<string, unknown>>;
  want: OpenPullRequest[];
}
