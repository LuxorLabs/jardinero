import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import {
  RequestBodyTooLargeError,
  bodyTooLargeResponse,
  headerValue,
  parseJsonObjectBody,
  readJsonObjectBody,
  readRawBody,
} from './request.js';

describe('headerValue', () => {
  const cases: Array<{ name: string; value: string | string[] | undefined; want?: string }> = [
    {
      name: 'When the header appears once then should return it',
      value: 'sha256=abc',
      want: 'sha256=abc',
    },
    {
      // A repeated security header must resolve to one value, never a join: the
      // signature check has to see exactly what one of the senders signed.
      name: 'When the header is repeated then should return the first value',
      value: ['first', 'second'],
      want: 'first',
    },
    { name: 'When the header is absent then should return undefined', value: undefined },
    { name: 'When the header is an empty list then should return undefined', value: [] },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(headerValue(testCase.value), testCase.want);
    });
  }
});

describe('readRawBody', () => {
  test('When the body arrives in chunks then should concatenate them', async () => {
    const body = await readRawBody(stream(['{"a":', '1}']));

    assert.equal(body.toString('utf8'), '{"a":1}');
  });

  // The cap is enforced while reading, so an oversized upload is refused before
  // it is buffered rather than after.
  test('When the body exceeds the cap then should return error', async () => {
    const oversized = 'x'.repeat(1_048_577);

    await assert.rejects(readRawBody(stream([oversized])), RequestBodyTooLargeError);
  });
});

describe('parseJsonObjectBody', () => {
  const cases: Array<{
    name: string;
    raw: string;
    want: { body: Record<string, unknown> } | { status: number; error: string };
  }> = [
    {
      name: 'When the body is a json object then should return it',
      raw: '{"confirmed":true}',
      want: { body: { confirmed: true } },
    },
    {
      // Optional-body routes like abort send nothing at all; that is not an error.
      name: 'When the body is empty then should return an empty object',
      raw: '',
      want: { body: {} },
    },
    {
      name: 'When the body is only whitespace then should return an empty object',
      raw: '   \n ',
      want: { body: {} },
    },
    {
      name: 'When the body is not json then should return error',
      raw: 'not json at all',
      want: { status: 400, error: 'invalid_json_body' },
    },
    {
      name: 'When the body is a json array then should return error',
      raw: '[1,2]',
      want: { status: 400, error: 'invalid_json_body' },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const parsed = parseJsonObjectBody(testCase.raw);

      if ('body' in testCase.want) {
        assert.deepEqual(parsed, { body: testCase.want.body });
        return;
      }
      assert.deepEqual(parsed, {
        response: { status: testCase.want.status, body: { error: testCase.want.error } },
      });
    });
  }
});

describe('bodyTooLargeResponse', () => {
  test('When the body was refused then should answer 413', () => {
    assert.deepEqual(bodyTooLargeResponse(), {
      status: 413,
      body: { error: 'request_body_too_large' },
    });
  });
});

describe('readJsonObjectBody', () => {
  const cases: Array<{
    name: string;
    chunks: string[];
    want: { body: Record<string, unknown> } | { status: number; error: string };
  }> = [
    {
      name: 'When the body is a json object then should return it without answering',
      chunks: ['{"confirmed":', 'true}'],
      want: { body: { confirmed: true } },
    },
    {
      name: 'When the body is empty then should return an empty object',
      chunks: [],
      want: { body: {} },
    },
    {
      name: 'When the body is not json then should answer 400',
      chunks: ['not json at all'],
      want: { status: 400, error: 'invalid_json_body' },
    },
    {
      // The cap is the reason this wrapper exists: the reader throws mid-stream and
      // the envelope error is answered here rather than escaping as a 500.
      name: 'When the body exceeds the cap then should answer 413',
      chunks: ['x'.repeat(1_048_577)],
      want: { status: 413, error: 'request_body_too_large' },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const written: Array<{ status: number; payload: unknown }> = [];
      const response = {
        writeHead(status: number) {
          written.push({ status, payload: undefined });
        },
        end(payload: unknown) {
          if (written.length > 0) written[written.length - 1].payload = payload;
        },
      };

      const body = await readJsonObjectBody(
        stream(testCase.chunks),
        response as unknown as Parameters<typeof readJsonObjectBody>[1],
      );

      if ('body' in testCase.want) {
        assert.deepEqual(body, testCase.want.body);
        assert.deepEqual(written, [], 'a readable body must not be answered here');
        return;
      }
      assert.equal(body, undefined);
      assert.equal(written[0]?.status, testCase.want.status);
      assert.deepEqual(JSON.parse(String(written[0].payload)), { error: testCase.want.error });
    });
  }
});

function stream(chunks: string[]): Parameters<typeof readRawBody>[0] {
  return Readable.from(chunks.map((chunk) => Buffer.from(chunk))) as unknown as Parameters<
    typeof readRawBody
  >[0];
}
