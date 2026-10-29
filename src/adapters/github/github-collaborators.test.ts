import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { canPushToRepository } from './github-collaborators.js';

describe('canPushToRepository', () => {
  const cases: Array<{
    name: string;
    answer: () => Response;
    want: { answer?: boolean; error?: RegExp };
  }> = [
    {
      name: 'When GitHub does not know the login then should answer no',
      answer: () => new Response('{"message":"Not Found"}', { status: 404 }),
      want: { answer: false },
    },
    {
      name: 'When GitHub refuses the lookup then should return error',
      answer: () => new Response('nope', { status: 502 }),
      want: { error: /permission lookup for lucio on acme\/webapp failed with HTTP 502/ },
    },
    {
      name: 'When the body is not json then should return error',
      answer: () => new Response('{not json', { status: 200 }),
      want: { error: /returned invalid JSON/ },
    },
    {
      name: 'When the body is not an object then should return error',
      answer: () => jsonResponse(['write']),
      want: { error: /returned no permission/ },
    },
    {
      name: 'When the body carries no permission then should return error',
      answer: () => jsonResponse({ role_name: 'write' }),
      want: { error: /returned no permission/ },
    },
    {
      name: 'When the login is an `admin` then should answer yes',
      answer: () => jsonResponse({ permission: 'admin' }),
      want: { answer: true },
    },
    {
      name: 'When the login can `write` then should answer yes',
      answer: () => jsonResponse({ permission: 'write' }),
      want: { answer: true },
    },
    {
      name: 'When the login can only `read` then should answer no',
      answer: () => jsonResponse({ permission: 'read' }),
      want: { answer: false },
    },
    {
      name: 'When the login has `none` then should answer no',
      answer: () => jsonResponse({ permission: 'none' }),
      want: { answer: false },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const asked: string[] = [];
      let error = '';
      const answer = await canPushToRepository({
        repo: 'acme/webapp',
        login: 'lucio',
        token: 'gh_token',
        fetchImpl: ((input: string) => {
          asked.push(String(input));
          return Promise.resolve(c.answer());
        }) as unknown as typeof fetch,
      }).catch((failure: Error) => {
        error = failure.message;
        return undefined;
      });

      assert.equal(answer, c.want.answer);
      assert.match(error, c.want.error ?? /^$/);
      assert.deepEqual(asked, [
        'https://api.github.com/repos/acme/webapp/collaborators/lucio/permission',
      ]);
    });
  }
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
