import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import type { AppConfig } from '../config.js';
import { DEMO_LOG_REVIEW_TARGET, configWithLogReview } from './config.js';
import { createApiServer } from '../transport/server.js';
import type { Store } from '../store/store.js';
import { createEngineCommands } from '../orchestrator/engine-commands.js';
import { MockWorkerRunner } from '../orchestrator/worker/mock-worker.js';
import {
  delegateLinearIssue,
  openLinearIssueForRequest,
} from '../adapters/linear/linear-delegation.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { createTestStore } from './store.js';

export interface HttpFixture {
  baseUrl: string;
  store: Store;
  cleanup(): Promise<void>;
}

export async function createHttpFixture(
  env: NodeJS.ProcessEnv = {},
  options: {
    linearEnabled?: boolean;
    linearImplementerConcurrency?: number;
    linearTeamRepos?: AppConfig['workflows']['linearImplementer']['teamRepos'];
    prMaintainerEnabled?: boolean;
    discordEnabled?: boolean;
    discordAllowedRoleIds?: string[];
    discordRepoChannels?: Record<string, string>;
    people?: AppConfig['people'];
    fetchImpl?: typeof fetch;
    maxConcurrentSandboxes?: number;
    logReviewRepos?: AppConfig['workflows']['logReviewer']['repos'];
  } = {},
): Promise<HttpFixture> {
  const { store, dataPath: tempDir, cleanup: closeStore } = createTestStore();
  const config = configWithLogReview(options.logReviewRepos);
  config.store.dataPath = tempDir;
  config.worker.runner = 'mock';
  config.workflows.requestRouter.enabled = true;
  config.workflows.linearImplementer.teamRepos = { JAR: DEMO_LOG_REVIEW_TARGET.repo };
  config.sandboxes.maxConcurrentRuns = options.maxConcurrentSandboxes ?? 1;
  config.workflows.prMaintainer.maxConcurrentRuns = 1;
  if (options.prMaintainerEnabled !== undefined) {
    config.workflows.prMaintainer.enabled = options.prMaintainerEnabled;
  }
  if (options.linearEnabled !== undefined)
    config.workflows.linearImplementer.enabled = options.linearEnabled;
  if (options.linearImplementerConcurrency !== undefined) {
    config.workflows.linearImplementer.maxConcurrentRuns = options.linearImplementerConcurrency;
  }
  if (options.linearTeamRepos !== undefined) {
    config.workflows.linearImplementer.teamRepos = options.linearTeamRepos;
  }
  if (options.discordEnabled !== undefined) config.discord.enabled = options.discordEnabled;
  if (options.discordAllowedRoleIds !== undefined) {
    config.discord.allowedRoleIds = options.discordAllowedRoleIds;
  }
  if (options.discordRepoChannels !== undefined) {
    config.discord.repoChannels = options.discordRepoChannels;
  }
  if (options.people !== undefined) config.people = options.people;

  // Stubs both Linear and GitHub GraphQL so session acks and PR-ready calls
  // resolve without touching the network.
  const graphqlSuccess: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          agentActivityCreate: { success: true },
          agentSessionUpdate: { success: true },
          markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const fetchImpl = options.fetchImpl ?? graphqlSuccess;

  const orchestrator = new Orchestrator({
    config,
    store,
    runner: new MockWorkerRunner(),
    github: silentGitHubReader(),
    env,
    fetchImpl,
  });
  const commands = createEngineCommands({
    config,
    store,
    engines: orchestrator,
    delegateTicket: (ticket, ownerLinearUserId) =>
      delegateLinearIssue({ config, env, fetchImpl }, ticket, ownerLinearUserId),
    openTicketForRequest: (request) =>
      openLinearIssueForRequest({ config, env, fetchImpl }, request),
    operatedWorkflows: orchestrator.operatedWorkflows,
    pool: orchestrator.pool,
    env,
    fetchImpl,
  });
  const server = createApiServer({
    config,
    store,
    commands,
    env,
    fetchImpl,
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
    cleanup: async () => {
      await orchestrator.stop();
      // An open SSE stream keeps close() pending forever, so drop sockets first.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      closeStore();
    },
  };
}

export function githubSignature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function linearSignature(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function linearSessionBody(
  action: string,
  issue: { identifier?: string; teamKey?: string; project?: { id: string; name: string } } = {},
): string {
  const identifier = issue.identifier ?? 'JAR-7';
  return JSON.stringify({
    type: 'AgentSessionEvent',
    action,
    webhookTimestamp: Date.now(),
    agentSession: {
      id: 'session-http-1',
      issue: {
        id: `issue-${identifier}`,
        identifier,
        title: 'Test issue',
        url: `https://linear.app/acme/issue/${identifier}/test-issue`,
        team: { key: issue.teamKey ?? 'JAR' },
        ...(issue.project ? { project: issue.project } : {}),
      },
    },
    promptContext: 'Do the thing.',
  });
}

export function readEvents(store: Store, eventType: string): Array<Record<string, unknown>> {
  return store
    .queryReadOnly('SELECT metadata FROM event_log WHERE event_type = ? ORDER BY created_at', [
      eventType,
    ])
    .map((row) => JSON.parse((row as { metadata: string | null }).metadata ?? '{}'));
}

export async function readStreamUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs = 1_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const timeout = AbortSignal.timeout(timeoutMs);
  while (!timeout.aborted) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<Awaited<ReturnType<typeof reader.read>>>((_, reject) => {
        timeout.addEventListener('abort', () => reject(new Error('stream timeout')), {
          once: true,
        });
      }),
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    // An SSE event is complete only at its blank line; the event name can
    // arrive in a chunk before its `data:` payload.
    const at = buffer.indexOf(needle);
    if (at >= 0 && buffer.includes('\n\n', at)) return buffer;
  }
  throw new Error(`stream did not include ${needle}: ${buffer}`);
}

export async function eventually(assertion: () => void, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

export const ADMIN_TOKEN = 'admin-token';

export function post(
  fixture: { baseUrl: string },
  route: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${fixture.baseUrl}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function get(fixture: { baseUrl: string }, route: string): Promise<Response> {
  return fetch(`${fixture.baseUrl}${route}`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
}

export function dashboardGet(fixture: { baseUrl: string }, route: string): Promise<Response> {
  return fetch(`${fixture.baseUrl}${route}`, { headers: dashboardIdentityHeaders() });
}

export async function dashboardPost(
  fixture: { baseUrl: string },
  route: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${fixture.baseUrl}${route}`, {
    method: 'POST',
    headers: { ...dashboardIdentityHeaders(), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function dashboardPostWithHeaders(
  fixture: { baseUrl: string },
  route: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(`${fixture.baseUrl}${route}`, {
    method: 'POST',
    headers: { ...dashboardIdentityHeaders(), 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

export function dashboardIdentityHeaders(): Record<string, string> {
  return { 'x-pomerium-claim-email': 'operator@example.test' };
}

export async function createAgentsHttpFixture(configure?: (config: AppConfig) => void): Promise<{
  baseUrl: string;
  store: Store;
  cleanup(): Promise<void>;
}> {
  const { store, dataPath: tempDir, cleanup: closeStore } = createTestStore();
  const env = { ORCHESTRATOR_ADMIN_TOKEN: 'admin-token' };
  const config = configWithLogReview();
  config.store.dataPath = tempDir;
  config.worker.runner = 'mock';
  config.workflows.linearImplementer.teamRepos = { JAR: DEMO_LOG_REVIEW_TARGET.repo };
  configure?.(config);

  const orchestrator = new Orchestrator({
    config,
    store,
    runner: new MockWorkerRunner(),
    github: silentGitHubReader(),
  });
  const commands = createEngineCommands({
    config,
    store,
    engines: orchestrator,
    delegateTicket: (ticket) => delegateLinearIssue({ config, env }, ticket),
    openTicketForRequest: (request) => openLinearIssueForRequest({ config, env }, request),
    operatedWorkflows: orchestrator.operatedWorkflows,
    pool: orchestrator.pool,
    env,
  });
  const server = createApiServer({
    config,
    store,
    commands,
    env,
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
    cleanup: async () => {
      // An open SSE stream keeps close() pending forever, so drop sockets first.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      closeStore();
    },
  };
}

export async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function snapshotVersion(chunk: string): string {
  const match = /"version":"([^"]+)"/.exec(chunk);
  assert(match);
  return match[1];
}

// A node request/response pair for handlers that write to the socket instead of
// returning a `HandlerResponse`, so they can be called straight from a unit test.
export function fakeRequest(
  options: {
    method?: string;
    body?: unknown;
    rawBody?: string;
    headers?: IncomingHttpHeaders;
  } = {},
): IncomingMessage {
  const raw = options.rawBody ?? (options.body === undefined ? '' : JSON.stringify(options.body));
  const request = Readable.from(raw ? [raw] : []) as unknown as IncomingMessage;
  request.method = options.method ?? 'POST';
  request.headers = options.headers ?? {};
  // The dashboard audit trail reads the peer address off the socket.
  (request as { socket: { remoteAddress: string } }).socket = { remoteAddress: '127.0.0.1' };
  return request;
}

export function responseRecorder(): {
  response: ServerResponse;
  status(): number | undefined;
  headers(): Record<string, string> | undefined;
  body(): Record<string, unknown>;
} {
  let status: number | undefined;
  let headers: Record<string, string> | undefined;
  let payload: unknown;
  const response = {
    writeHead(nextStatus: number, nextHeaders: Record<string, string>) {
      status = nextStatus;
      headers = nextHeaders;
    },
    end(nextPayload: unknown) {
      payload = nextPayload;
    },
  } as unknown as ServerResponse;

  return {
    response,
    status: () => status,
    headers: () => headers,
    body: () => JSON.parse(String(payload ?? '{}')) as Record<string, unknown>,
  };
}

// silentGitHubReader answers that there is nothing to do: a fixture that wants the
// PrMaintainer to act drives its events directly.
function silentGitHubReader() {
  return {
    readPullRequest: () =>
      Promise.resolve({
        state: 'open' as const,
        headCommitSha: '',
        checksAreRed: false,
        hasUnresolvedReviewThreads: false,
      }),
    markReadyForReview: () => Promise.resolve(undefined),
    findOpenImplementationPullRequest: () => Promise.resolve(undefined),
    markCommentPickedUp: () => Promise.resolve(undefined),
  };
}
