import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonObject } from '../platform/json.js';
import { type HandlerResponse, send } from './respond.js';

// headerValue answers the first value, because Node lowercases header names but keeps
// repeats as arrays, and a repeated security header must not silently win.
export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export interface RawRequest {
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

const MAX_REQUEST_BODY_BYTES = 1_048_576; // 1 MiB: every accepted body is small JSON.

export class RequestBodyTooLargeError extends Error {}

export async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BODY_BYTES) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

// parseJsonObjectBody classifies a body without touching the socket, so the envelope
// errors are decided in one place instead of at every route.
export function parseJsonObjectBody(
  raw: string,
): { body: Record<string, unknown> } | { response: HandlerResponse } {
  if (raw.trim().length === 0) return { body: {} };
  try {
    return { body: parseJsonObject(raw) };
  } catch {
    return { response: { status: 400, body: { error: 'invalid_json_body' } } };
  }
}

export function bodyTooLargeResponse(): HandlerResponse {
  return { status: 413, body: { error: 'request_body_too_large' } };
}

// readJsonObjectBody reads and classifies, so a handler receives a parsed object or
// nothing at all.
export async function readJsonObjectBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = (await readRawBody(request)).toString('utf8');
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      send(response, bodyTooLargeResponse());
      return undefined;
    }
    throw error;
  }
  const parsed = parseJsonObjectBody(raw);
  if ('response' in parsed) {
    send(response, parsed.response);
    return undefined;
  }
  return parsed.body;
}
