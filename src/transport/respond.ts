import type { ServerResponse } from 'node:http';

// HandlerResponse is what a handler returns instead of writing to the socket, which is
// what makes it callable straight from a test. The two SSE endpoints are the deliberate
// exception.
export interface HandlerResponse {
  status: number;
  headers?: Record<string, string>;
  // JSON-encoded on the way out. Ignored when `raw` is set.
  body?: unknown;
  // Bytes to send verbatim, for artifacts and static assets.
  raw?: Buffer | string;
}

export function send(response: ServerResponse, result: HandlerResponse): void {
  if (result.raw !== undefined) {
    response.writeHead(result.status, result.headers ?? {});
    response.end(result.raw);
    return;
  }
  response.writeHead(result.status, {
    'content-type': 'application/json; charset=utf-8',
    ...result.headers,
  });
  response.end(JSON.stringify(result.body ?? {}));
}

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  send(response, { status, body: payload });
}

export function sendArtifact(response: ServerResponse, name: string, content: Buffer): void {
  const filename = name.split('/').filter(Boolean).at(-1) ?? 'artifact';
  send(response, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(content.byteLength),
      'content-disposition': `attachment; filename="${filename.replaceAll('"', '')}"`,
      'cache-control': 'no-store',
    },
    raw: content,
  });
}

export function sendHtml(response: ServerResponse, status: number, html: string): void {
  send(response, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    raw: html,
  });
}
