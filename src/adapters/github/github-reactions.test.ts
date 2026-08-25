import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type ReactionContent,
  isReactionContent,
  postCommentReaction,
} from './github-reactions.js';

describe('postCommentReaction', () => {
  const endpointCases: Array<{
    name: string;
    commentType: 'review' | 'issue';
    commentId: number;
    content: ReactionContent;
    wantUrl: string;
  }> = [
    {
      name: 'When comment is a review comment then should post to pulls endpoint',
      commentType: 'review',
      commentId: 42,
      content: 'eyes',
      wantUrl: 'https://api.github.com/repos/Org/repo/pulls/comments/42/reactions',
    },
    {
      name: 'When comment is an issue comment then should post to issues endpoint',
      commentType: 'issue',
      commentId: 7,
      content: 'rocket',
      wantUrl: 'https://api.github.com/repos/Org/repo/issues/comments/7/reactions',
    },
  ];

  for (const c of endpointCases) {
    test(c.name, async () => {
      const captured: { url?: string; init?: RequestInit } = {};
      const fakeFetch: typeof fetch = async (input, init) => {
        captured.url = typeof input === 'string' ? input : input.toString();
        captured.init = init;
        return new Response('{}', { status: 201 });
      };

      await postCommentReaction({
        repo: 'Org/repo',
        commentType: c.commentType,
        commentId: c.commentId,
        content: c.content,
        token: 'tok',
        fetchImpl: fakeFetch,
      });

      assert.equal(captured.url, c.wantUrl);
      assert.equal(captured.init?.method, 'POST');
      assert.equal(JSON.parse(String(captured.init?.body)).content, c.content);
      const headers = captured.init?.headers as Record<string, string>;
      assert.equal(headers.authorization, 'Bearer tok');
      assert.equal(headers['content-type'], 'application/json');
    });
  }

  test('When response is not ok then should return error', async () => {
    const fakeFetch: typeof fetch = async () => new Response('forbidden', { status: 403 });
    await assert.rejects(
      postCommentReaction({
        repo: 'Org/repo',
        commentType: 'issue',
        commentId: 7,
        content: 'eyes',
        token: 'tok',
        fetchImpl: fakeFetch,
      }),
      /HTTP 403/,
    );
  });

  test('When error body has message then should include it', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
        status: 403,
      });
    await assert.rejects(
      postCommentReaction({
        repo: 'Org/repo',
        commentType: 'issue',
        commentId: 7,
        content: 'eyes',
        token: 'tok',
        fetchImpl: fakeFetch,
      }),
      /HTTP 403: Resource not accessible by integration/,
    );
  });
});

describe('isReactionContent', () => {
  const reactionContentCases: Array<{ value: string; want: boolean }> = [
    { value: 'eyes', want: true },
    { value: 'rocket', want: true },
    { value: '+1', want: true },
    { value: 'thumbsup', want: false },
    { value: 'tada', want: false },
    { value: '', want: false },
  ];

  for (const c of reactionContentCases) {
    test(`When the value is ${c.value || 'empty'} then should validate`, () => {
      assert.equal(isReactionContent(c.value), c.want);
    });
  }
});
