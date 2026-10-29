import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type AppConfig, loadConfig } from '../config.js';
import { GitHubPullRequests } from './github-pull-requests.js';
import type { PickedUpComment } from './state-machines/pr-maintainer/service.js';

const CONFIG = loadConfig();
const TOKEN_ENV = CONFIG.worker.githubTokenEnv;
const REPOSITORY = 'acme/web.app';
const PULL_REQUEST_NUMBER = 4688;

describe('GitHubPullRequests.authorCanPush', () => {
  const cases: AuthorAccessCase[] = [
    {
      name: 'When the answer is still fresh then should answer from memory',
      asks: [{ atMs: 0 }, { atMs: 60_000, login: 'Lucio' }],
      answers: [permission('write'), permission('read')],
      want: { answers: [true, true], fetches: 1 },
    },
    {
      name: 'When the answer is older than five minutes then should ask again',
      asks: [{ atMs: 0 }, { atMs: 300_000 }],
      answers: [permission('write'), permission('read')],
      want: { answers: [true, false], fetches: 2 },
    },
    {
      name: 'When there is no token then should answer no without asking',
      withToken: false,
      asks: [{ atMs: 0 }],
      answers: [permission('write')],
      want: { answers: [false], fetches: 0 },
    },
    {
      name: 'When GitHub says the author cannot push then should answer no',
      asks: [{ atMs: 0 }],
      answers: [permission('read')],
      want: { answers: [false], fetches: 1 },
    },
    {
      name: 'When GitHub fails then should answer no and ask again next time',
      asks: [{ atMs: 0 }, { atMs: 0 }],
      answers: [new Response('nope', { status: 502 }), permission('write')],
      want: { answers: [false, true], fetches: 2 },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      let nowMs = 0;
      const answers = [...c.answers];
      let fetches = 0;
      const github = new GitHubPullRequests(
        CONFIG,
        env(c.withToken),
        (() => {
          fetches += 1;
          return Promise.resolve(answers.shift());
        }) as unknown as typeof fetch,
        () => nowMs,
      );

      const got: boolean[] = [];
      for (const ask of c.asks) {
        nowMs = ask.atMs;
        got.push(await github.authorCanPush(REPOSITORY, ask.login ?? 'lucio'));
      }

      assert.deepEqual(got, c.want.answers);
      assert.equal(fetches, c.want.fetches);
    });
  }
});

describe('GitHubPullRequests.isForkPullRequest', () => {
  const cases: Array<{ name: string; withToken?: boolean; answer: () => Response; want: boolean }> =
    [
      {
        name: 'When there is no token then should treat it as a fork',
        withToken: false,
        answer: () => jsonResponse(pullRequestHead(7)),
        want: true,
      },
      {
        name: 'When the head is in the repository itself then should say it is not a fork',
        answer: () => jsonResponse(pullRequestHead(7)),
        want: false,
      },
      {
        name: 'When the head is in another repository then should say it is a fork',
        answer: () => jsonResponse(pullRequestHead(8)),
        want: true,
      },
      {
        name: 'When GitHub fails then should treat it as a fork',
        answer: () => new Response('nope', { status: 502 }),
        want: true,
      },
    ];

  for (const c of cases) {
    test(c.name, async () => {
      const github = new GitHubPullRequests(CONFIG, env(c.withToken), fetchAnswering(c.answer));

      assert.equal(await github.isForkPullRequest(REPOSITORY, PULL_REQUEST_NUMBER), c.want);
    });
  }
});

describe('GitHubPullRequests.readPullRequest', () => {
  const cases: ReadCase[] = [
    {
      name: 'When the pull request is open with clean checks then should answer nothing to do',
      answer: () => jsonResponse(pullRequest()),
      want: { state: 'open', headCommitSha: 'sha-1', checksAreRed: false, unresolved: false },
    },
    {
      name: 'When the pull request was merged then should answer merged',
      answer: () => jsonResponse(pullRequest({ merged: true })),
      want: { state: 'merged', headCommitSha: 'sha-1', checksAreRed: false, unresolved: false },
    },
    {
      name: 'When the checks are red then should answer so',
      answer: () => jsonResponse(pullRequest({ rollup: 'FAILURE' })),
      want: { state: 'open', headCommitSha: 'sha-1', checksAreRed: true, unresolved: false },
    },
    {
      name: 'When a review thread is open then should answer so',
      answer: () =>
        jsonResponse(pullRequest({ threads: [{ isResolved: false, isOutdated: false }] })),
      want: { state: 'open', headCommitSha: 'sha-1', checksAreRed: false, unresolved: true },
    },
    {
      // Leaving the instance where it is, is the only safe answer when we cannot see
      // the pull request.
      name: 'When github refuses the query then should answer open with nothing to do',
      answer: () => new Response('nope', { status: 500 }),
      want: { state: 'open', headCommitSha: '', checksAreRed: false, unresolved: false },
    },
    {
      name: 'When there is no token then should answer open with nothing to do',
      withToken: false,
      answer: () => jsonResponse(pullRequest({ rollup: 'FAILURE' })),
      want: { state: 'open', headCommitSha: '', checksAreRed: false, unresolved: false },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const github = new GitHubPullRequests(CONFIG, env(c.withToken), fetchAnswering(c.answer));

      const snapshot = await github.readPullRequest(REPOSITORY, PULL_REQUEST_NUMBER);

      assert.equal(snapshot.state, c.want.state);
      assert.equal(snapshot.headCommitSha, c.want.headCommitSha);
      assert.equal(snapshot.checksAreRed, c.want.checksAreRed);
      assert.equal(snapshot.hasUnresolvedReviewThreads, c.want.unresolved);
    });
  }
});

describe('GitHubPullRequests.markReadyForReview', () => {
  const cases: WriteCase[] = [
    {
      name: 'When the pull request is a draft then should mark it ready',
      answers: [
        jsonResponse({ node_id: 'node-1', draft: true, head: { ref: 'agent/x' } }),
        () =>
          jsonResponse(
            { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
            true,
          ),
      ],
      want: { error: undefined, calls: 2 },
    },
    {
      // The mutation rejects a pull request that is not a draft, so asking twice must
      // not answer an error.
      name: 'When the pull request is already ready then should answer without asking again',
      answers: [jsonResponse({ node_id: 'node-1', draft: false, head: { ref: 'agent/x' } })],
      want: { error: undefined, calls: 1 },
    },
    {
      name: 'When github refuses the lookup then should answer the error',
      answers: [() => new Response('nope', { status: 404 })],
      want: { error: /HTTP 404/, calls: 1 },
    },
    {
      name: 'When there is no token then should answer the error without asking',
      withToken: false,
      answers: [],
      want: { error: /missing github token/, calls: 0 },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      let calls = 0;
      const github = new GitHubPullRequests(CONFIG, env(c.withToken), ((): Promise<Response> => {
        const answer = c.answers[calls];
        calls += 1;
        return Promise.resolve(typeof answer === 'function' ? answer() : (answer as Response));
      }) as unknown as typeof fetch);

      const error = await github.markReadyForReview(REPOSITORY, PULL_REQUEST_NUMBER);

      assert.equal(calls, c.want.calls);
      if (c.want.error) assert.match(error?.message ?? '', c.want.error);
      else assert.equal(error, undefined);
    });
  }
});

describe('GitHubPullRequests.markCommentPickedUp', () => {
  const cases: PickupCase[] = [
    {
      name: 'When the comment is on the conversation then should react on the issue endpoint',
      comment: { commentType: 'issue', commentExternalId: '991' },
      want: { url: `https://api.github.com/repos/${REPOSITORY}/issues/comments/991/reactions` },
    },
    {
      name: 'When the comment is on a review thread then should react on the review endpoint',
      comment: { commentType: 'review', commentExternalId: '991' },
      want: { url: `https://api.github.com/repos/${REPOSITORY}/pulls/comments/991/reactions` },
    },
    {
      name: 'When reactions are turned off then should react to nothing',
      config: withoutReactions(),
      comment: { commentType: 'issue', commentExternalId: '991' },
      want: {},
    },
    {
      // GitHub numbers every comment, so an id that is not a number is not one of its
      // comments and there is nowhere to react.
      name: 'When the comment id is not a number then should react to nothing',
      comment: { commentType: 'issue', commentExternalId: 'not-a-number' },
      want: {},
    },
    {
      name: 'When there is no token then should answer the error without asking',
      withToken: false,
      comment: { commentType: 'issue', commentExternalId: '991' },
      want: { error: /missing github token/ },
    },
    {
      name: 'When github refuses the reaction then should answer the error',
      answer: () =>
        new Response('{"message":"Resource not accessible by integration"}', { status: 403 }),
      comment: { commentType: 'issue', commentExternalId: '991' },
      want: {
        url: `https://api.github.com/repos/${REPOSITORY}/issues/comments/991/reactions`,
        error: /HTTP 403/,
      },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const asked: string[] = [];
      const github = new GitHubPullRequests(
        c.config ?? CONFIG,
        env(c.withToken),
        recordingFetch(asked, c.answer),
      );

      const error = await github.markCommentPickedUp(REPOSITORY, c.comment);

      assert.deepEqual(asked, c.want.url ? [c.want.url] : []);
      if (c.want.error) assert.match(error?.message ?? '', c.want.error);
      else assert.equal(error, undefined);
    });
  }
});

describe('GitHubPullRequests.findOpenImplementationPullRequest', () => {
  const cases: LookupCase[] = [
    {
      name: 'When an open pull request already covers the problem then should answer it',
      answer: () => jsonResponse([openImplementationPr()]),
      want: 4688,
    },
    {
      name: 'When no open pull request covers it then should answer nothing',
      answer: () => jsonResponse([]),
      want: undefined,
    },
    {
      name: 'When github refuses the lookup then should answer nothing',
      answer: () => new Response('nope', { status: 500 }),
      want: undefined,
    },
    {
      name: 'When there is no token then should answer nothing',
      withToken: false,
      answer: () => jsonResponse([openImplementationPr()]),
      want: undefined,
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const github = new GitHubPullRequests(CONFIG, env(c.withToken), fetchAnswering(c.answer));

      const found = await github.findOpenImplementationPullRequest(REPOSITORY, {
        fingerprint: 'checkout-service-null-payment',
        service: 'checkout-service',
        environment: 'production',
        likelyFilesOrSymbols: ['CheckoutService'],
      });

      assert.equal(found?.number, c.want);
    });
  }
});

function env(withToken = true): NodeJS.ProcessEnv {
  return withToken ? { [TOKEN_ENV]: 'gh_token' } : {};
}

function fetchAnswering(answer: () => Response): typeof fetch {
  return (() => Promise.resolve(answer())) as unknown as typeof fetch;
}

// recordingFetch keeps the urls asked, which is how a case says which endpoint the
// reaction went to.
function recordingFetch(asked: string[], answer?: () => Response): typeof fetch {
  return ((input: string): Promise<Response> => {
    asked.push(String(input));
    return Promise.resolve(answer ? answer() : new Response('{}', { status: 201 }));
  }) as unknown as typeof fetch;
}

// A config with the reactions turned off, which is the operator switch this port reads.
function withoutReactions(): AppConfig {
  const config = loadConfig();
  config.workflows.prMaintainer.commentReactions.enabled = false;
  return config;
}

function jsonResponse(body: unknown, wrapped = false): Response {
  return new Response(JSON.stringify(wrapped ? { data: body } : body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function pullRequest(
  overrides: { merged?: boolean; rollup?: string; threads?: unknown[] } = {},
): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          state: 'OPEN',
          merged: overrides.merged ?? false,
          headRefOid: 'sha-1',
          commits: {
            nodes: [{ commit: { statusCheckRollup: { state: overrides.rollup ?? 'SUCCESS' } } }],
          },
          reviewThreads: { nodes: overrides.threads ?? [] },
        },
      },
    },
  };
}

function permission(value: string): Response {
  return jsonResponse({ permission: value });
}

function pullRequestHead(headRepositoryId: number): unknown {
  return {
    node_id: 'PR_node',
    head: { ref: 'feature', repo: { id: headRepositoryId } },
    base: { repo: { id: 7 } },
  };
}

function openImplementationPr(): unknown {
  return {
    number: PULL_REQUEST_NUMBER,
    state: 'open',
    html_url: `https://github.com/${REPOSITORY}/pull/${PULL_REQUEST_NUMBER}`,
    title: 'fix: checkout-service null payment handling',
    body: 'Source log review run id: old-run\nService/env: checkout-service / production',
    head: { ref: 'agent/checkout-service-null-payment', repo: { id: 7 } },
    base: { repo: { id: 7 } },
  };
}

interface AuthorAccessCase {
  name: string;
  withToken?: boolean;
  asks: Array<{ atMs: number; login?: string }>;
  answers: Response[];
  want: { answers: boolean[]; fetches: number };
}

interface ReadCase {
  name: string;
  withToken?: boolean;
  answer: () => Response;
  want: { state: string; headCommitSha: string; checksAreRed: boolean; unresolved: boolean };
}

interface WriteCase {
  name: string;
  withToken?: boolean;
  answers: Array<Response | (() => Response)>;
  want: { error?: RegExp; calls: number };
}

interface PickupCase {
  name: string;
  config?: AppConfig;
  withToken?: boolean;
  answer?: () => Response;
  comment: PickedUpComment;
  // url is the one endpoint the case expects asked; no url means nothing was asked.
  want: { url?: string; error?: RegExp };
}

interface LookupCase {
  name: string;
  withToken?: boolean;
  answer: () => Response;
  want: number | undefined;
}
