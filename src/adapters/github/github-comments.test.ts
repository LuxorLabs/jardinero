import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { postPullRequestComment } from './github-comments.js';

describe('postPullRequestComment', () => {
  const cases: Array<{
    name: string;
    status: number;
    responseBody: string;
    want?: { url: string; body: string };
    wantError?: RegExp;
  }> = [
    {
      name: 'When the pull request is named then should post on the conversation',
      status: 201,
      responseBody: '{}',
      want: {
        url: 'https://api.github.com/repos/Org/repo/issues/4816/comments',
        body: 'Codex login is revoked.',
      },
    },
    {
      name: 'When GitHub refuses with no body then should return the status',
      status: 502,
      responseBody: '',
      wantError: /HTTP 502$/,
    },
    {
      name: 'When GitHub refuses with a non-JSON body then should return the status',
      status: 500,
      responseBody: 'nope',
      wantError: /HTTP 500$/,
    },
    {
      name: 'When GitHub refuses with JSON that names no message then should return the status',
      status: 400,
      responseBody: '{}',
      wantError: /HTTP 400$/,
    },
    {
      name: 'When GitHub refuses then should return the status',
      status: 403,
      responseBody: JSON.stringify({ message: 'Resource not accessible by integration' }),
      wantError: /HTTP 403.*Resource not accessible/,
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const captured: { url?: string; init?: RequestInit } = {};
      const fakeFetch: typeof fetch = async (input, init) => {
        captured.url = typeof input === 'string' ? input : input.toString();
        captured.init = init;
        return new Response(c.responseBody, { status: c.status });
      };

      const posting = postPullRequestComment({
        repo: 'Org/repo',
        pullRequestNumber: c.want ? 4816 : 7,
        body: c.want?.body ?? 'no',
        token: 'tok',
        fetchImpl: fakeFetch,
      });

      if (c.wantError) {
        await assert.rejects(posting, c.wantError);
        return;
      }
      await posting;
      assert.equal(captured.url, c.want?.url);
      assert.equal(captured.init?.method, 'POST');
      assert.equal(JSON.parse(String(captured.init?.body)).body, c.want?.body);
      const headers = captured.init?.headers as Record<string, string>;
      assert.equal(headers.authorization, 'Bearer tok');
    });
  }
});
