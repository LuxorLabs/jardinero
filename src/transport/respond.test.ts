import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type HandlerResponse, send, sendArtifact, sendHtml, sendJson } from './respond.js';

describe('send', () => {
  const cases: Array<{
    name: string;
    result: HandlerResponse;
    wantStatus: number;
    wantHeaders: Record<string, string>;
    wantPayload: string;
  }> = [
    {
      name: 'When the result carries a body then should encode it as json',
      result: { status: 200, body: { ok: true } },
      wantStatus: 200,
      wantHeaders: { 'content-type': 'application/json; charset=utf-8' },
      wantPayload: '{"ok":true}',
    },
    {
      name: 'When the result has no body then should send an empty object',
      result: { status: 202 },
      wantStatus: 202,
      wantHeaders: { 'content-type': 'application/json; charset=utf-8' },
      wantPayload: '{}',
    },
    {
      // A handler that needs a different content type still gets json encoding;
      // only the header is its call.
      name: 'When the result sets headers then should merge them over the default',
      result: { status: 200, headers: { 'cache-control': 'no-store' }, body: [] },
      wantStatus: 200,
      wantHeaders: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
      wantPayload: '[]',
    },
    {
      name: 'When the result is raw then should send the bytes untouched',
      result: {
        status: 200,
        headers: { 'content-type': 'text/html' },
        raw: '<!doctype html>',
      },
      wantStatus: 200,
      wantHeaders: { 'content-type': 'text/html' },
      wantPayload: '<!doctype html>',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const written: { status?: number; headers?: Record<string, string>; payload?: unknown } = {};
      const response = {
        writeHead(status: number, headers: Record<string, string>) {
          written.status = status;
          written.headers = headers;
        },
        end(payload: unknown) {
          written.payload = payload;
        },
      };

      send(response as unknown as Parameters<typeof send>[0], testCase.result);

      assert.equal(written.status, testCase.wantStatus);
      assert.deepEqual(written.headers, testCase.wantHeaders);
      assert.equal(written.payload, testCase.wantPayload);
    });
  }
});

describe('sendJson', () => {
  test('When a payload is sent then should write it as json with the status', () => {
    const written = recorder();

    sendJson(written.response, 202, { ok: true });

    assert.equal(written.status, 202);
    assert.equal(written.headers?.['content-type'], 'application/json; charset=utf-8');
    assert.equal(written.payload, '{"ok":true}');
  });
});

describe('sendArtifact', () => {
  const cases: Array<{ name: string; artifact: string; wantFilename: string }> = [
    {
      name: 'When the artifact is a plain name then should offer it as the download name',
      artifact: 'handoff.json',
      wantFilename: 'handoff.json',
    },
    {
      // Artifacts are stored under a run-scoped path; only the last segment is a
      // filename, and a path in the header would let a client dictate a location.
      name: 'When the artifact has a path then should offer only its last segment',
      artifact: 'runs/abc/handoff.json',
      wantFilename: 'handoff.json',
    },
    {
      name: 'When the name carries a quote then should strip it from the header',
      artifact: 'we"ird.json',
      wantFilename: 'weird.json',
    },
    {
      name: 'When the name is only slashes then should fall back to a generic name',
      artifact: '///',
      wantFilename: 'artifact',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const written = recorder();

      sendArtifact(written.response, testCase.artifact, Buffer.from('body-bytes'));

      assert.equal(written.status, 200);
      assert.equal(written.headers?.['content-type'], 'application/octet-stream');
      assert.equal(written.headers?.['content-length'], '10');
      assert.equal(written.headers?.['cache-control'], 'no-store');
      assert.equal(
        written.headers?.['content-disposition'],
        `attachment; filename="${testCase.wantFilename}"`,
      );
      assert.equal(String(written.payload), 'body-bytes');
    });
  }
});

describe('sendHtml', () => {
  test('When html is sent then should mark it uncacheable', () => {
    const written = recorder();

    sendHtml(written.response, 404, '<p>gone</p>');

    assert.equal(written.status, 404);
    assert.equal(written.headers?.['content-type'], 'text/html; charset=utf-8');
    assert.equal(written.headers?.['cache-control'], 'no-store');
    assert.equal(written.payload, '<p>gone</p>');
  });
});

function recorder() {
  const written: {
    status?: number;
    headers?: Record<string, string>;
    payload?: unknown;
    response: Parameters<typeof send>[0];
  } = {
    response: undefined as unknown as Parameters<typeof send>[0],
  };
  written.response = {
    writeHead(status: number, headers: Record<string, string>) {
      written.status = status;
      written.headers = headers;
    },
    end(payload: unknown) {
      written.payload = payload;
    },
  } as unknown as Parameters<typeof send>[0];
  return written;
}
