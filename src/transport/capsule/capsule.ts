import { parseJsonObject } from '../../platform/json.js';
import { isSafeUuid } from '../../platform/ids.js';
import type { Store } from '../../store/store.js';
import type { SandboxRunState } from '../../store/types.js';
import type { HandlerResponse } from '../respond.js';

export interface CapsuleContext {
  store: Pick<Store, 'listSandboxRuns' | 'listEventsForSandboxRun' | 'queryReadOnly'>;
}

// capsuleResponse is the introspection surface behind the admin token: the run list, a
// run's raw event stream, and a read-only query.
export function capsuleResponse(
  context: CapsuleContext,
  request: { method: string; url: URL; rawBody: string },
): HandlerResponse {
  const { method, url } = request;

  if (method === 'GET' && url.pathname === '/capsule/runs') {
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const runState = url.searchParams.get('state') ?? undefined;
    return {
      status: 200,
      body: {
        runs: context.store.listSandboxRuns(
          Number.isFinite(limit) ? limit : 100,
          runState as SandboxRunState,
        ),
      },
    };
  }

  const eventMatch = /^\/capsule\/runs\/([^/]+)\/events$/.exec(url.pathname);
  if (method === 'GET' && eventMatch) {
    const sandboxRunId = decodeURIComponent(eventMatch[1]);
    if (!isSafeUuid(sandboxRunId)) return { status: 400, body: { error: 'invalid_run_id' } };
    return {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      raw: context.store
        .listEventsForSandboxRun(sandboxRunId)
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    };
  }

  if (method === 'POST' && url.pathname === '/capsule/sql') {
    const body = parseJsonObject(request.rawBody);
    const sql = typeof body.sql === 'string' ? body.sql : '';
    const params = Array.isArray(body.params) ? body.params : [];
    return { status: 200, body: { rows: context.store.queryReadOnly(sql, params as never[]) } };
  }

  return { status: 404, body: { error: 'capsule_route_not_found' } };
}
