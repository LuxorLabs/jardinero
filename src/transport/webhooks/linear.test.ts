import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type {
  LinearDelivery,
  LinearDeliveryOutcome,
} from '../../adapters/linear/linear-delivery.js';
import { loadConfig } from '../../config.js';
import type { Store } from '../../store/store.js';
import { createTestStore } from '../../testing/store.js';
import { type LinearWebhookContext, linearWebhookResponse } from './linear.js';

const SECRET = 'linsecret';

let store: Store;
let cleanup: () => void;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
});

afterEach(() => {
  cleanup();
});

describe('linearWebhookResponse', () => {
  const rejectionCases: RejectionCase[] = [
    {
      name: 'When the delivery carries no signature then should return error',
      signature: () => undefined,
      body: sessionBody(),
      want: { status: 401, error: 'invalid_signature' },
    },
    {
      name: 'When the signature does not match then should return error',
      signature: () => 'deadbeef',
      body: sessionBody(),
      want: { status: 401, error: 'invalid_signature' },
    },
    {
      name: 'When the signed body is not a json object then should return error',
      signature: sign,
      body: 'not json at all',
      want: { status: 400, error: 'invalid_json_body' },
    },
  ];

  for (const testCase of rejectionCases) {
    test(testCase.name, async () => {
      const fixture = createFixture();

      const signature = testCase.signature(testCase.body);

      const response = await linearWebhookResponse(
        fixture.context,
        request(testCase.body, signature ? { 'linear-signature': signature } : {}),
      );

      assert.equal(response.status, testCase.want.status);
      assert.deepEqual(response.body, { error: testCase.want.error });
      assert.deepEqual(fixture.delivered, []);
    });
  }

  // Linear retries a delivery inside its replay window; the durable guard makes the
  // retry a no-op instead of a second run for the same issue.
  test('When the delivery was already recorded then should report it duplicate', async () => {
    const fixture = createFixture();
    const body = sessionBody();
    const headers = { 'linear-signature': sign(body), 'linear-delivery': 'delivery-1' };

    const first = await linearWebhookResponse(fixture.context, request(body, headers));
    const second = await linearWebhookResponse(fixture.context, request(body, headers));

    assert.equal(first.status, 202);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { accepted: false, reason: 'duplicate_delivery' });
    assert.equal(fixture.delivered.length, 1);
    assert.equal(
      fixture.recorded.filter((entry) => entry === 'orchestrator.webhook_already_handled').length,
      1,
    );
  });

  const outcomeCases: OutcomeCase[] = [
    {
      name: 'When the ticket is taken then should report it queued and wake the dashboard',
      outcome: { handled: true, sessionId: 'session-1', issueIdentifier: 'JAR-7' },
      wantStatus: 202,
      wantNotified: 1,
    },
    {
      name: 'When the ticket is refused then should answer 200 without waking the dashboard',
      outcome: { handled: false, reason: 'event_ignored' },
      wantStatus: 200,
      wantNotified: 0,
    },
  ];

  for (const testCase of outcomeCases) {
    test(testCase.name, async () => {
      const fixture = createFixture({ outcome: testCase.outcome });
      const body = sessionBody();

      const response = await linearWebhookResponse(
        fixture.context,
        request(body, { 'linear-signature': sign(body) }),
      );

      assert.equal(response.status, testCase.wantStatus);
      assert.deepEqual(response.body, {
        accepted: testCase.outcome.handled,
        reason: testCase.outcome.reason,
      });
      assert.equal(fixture.notified(), testCase.wantNotified);
    });
  }

  test('When the delivery is authentic then should pass the payload on with its arrival time', async () => {
    const fixture = createFixture();
    const body = sessionBody();

    await linearWebhookResponse(fixture.context, request(body, { 'linear-signature': sign(body) }));

    assert.deepEqual(fixture.delivered.at(0)?.payload, JSON.parse(body) as Record<string, unknown>);
    assert.ok((fixture.delivered.at(0)?.nowMs ?? 0) > 0);
  });

  // Linear marks a session unresponsive unless an activity lands within ~10s, so the
  // ack fires here rather than waiting for a run to report anything.
  const ackCases: AckCase[] = [
    {
      name: 'When the ticket is taken then should tell the session it was picked up',
      outcome: { handled: true, sessionId: 'session-1', issueIdentifier: 'JAR-7' },
      want: { type: 'thought', body: /Picked up JAR-7/ },
    },
    {
      name: 'When the outcome names no ticket then should still answer the session',
      outcome: { handled: true, sessionId: 'session-1' },
      want: { type: 'thought', body: /Picked up the issue/ },
    },
    {
      name: 'When the team has no repository then should tell the session an operator must map it',
      outcome: { handled: false, reason: 'no_repo_for_team', sessionId: 'session-1' },
      want: { type: 'error', body: /No repository is configured for this team/ },
    },
    {
      name: 'When the action is a follow-up prompt then should say it is unsupported',
      outcome: { handled: false, reason: 'prompted_not_supported', sessionId: 'session-1' },
      want: { type: 'thought', body: /Follow-up prompts are not supported/ },
    },
    {
      // A delivery that was never about work leaves the person waiting on nothing.
      name: 'When the delivery was not about work then should post no activity',
      outcome: { handled: false, reason: 'event_ignored', sessionId: 'session-1' },
    },
    {
      name: 'When the delivery identified no session then should post no activity',
      outcome: { handled: false, reason: 'missing_agent_session' },
    },
  ];

  for (const testCase of ackCases) {
    test(testCase.name, async () => {
      const fixture = createFixture({ outcome: testCase.outcome });
      const body = sessionBody();

      await linearWebhookResponse(
        fixture.context,
        request(body, { 'linear-signature': sign(body) }),
      );

      assert.equal(fixture.activities.at(0)?.type, testCase.want?.type);
      if (testCase.want) assert.match(fixture.activities.at(0)?.body ?? '', testCase.want.body);
    });
  }

  test('When the api token is missing then should audit the skipped ack', async () => {
    const fixture = createFixture({ withToken: false, outcome: handedOver() });
    const body = sessionBody();

    await linearWebhookResponse(fixture.context, request(body, { 'linear-signature': sign(body) }));

    assert.equal(
      fixture.recorded.filter((entry) => entry === 'orchestrator.linear_reply_skipped').length,
      1,
    );
    assert.deepEqual(fixture.activities, []);
  });

  // The ack is best effort: it fires without awaiting, so a failing call must be
  // audited instead of surfacing as an unhandled rejection.
  test('When the ack call fails then should audit it', async () => {
    const fixture = createFixture({ ackFails: true, outcome: handedOver() });
    const body = sessionBody();

    const response = await linearWebhookResponse(
      fixture.context,
      request(body, { 'linear-signature': sign(body) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(response.status, 202);
    assert.equal(
      fixture.recorded.filter((entry) => entry === 'orchestrator.linear_reply_failed').length,
      1,
    );
  });
});

interface RejectionCase {
  name: string;
  signature(body: string): string | undefined;
  body: string;
  want: { status: number; error: string };
}

interface OutcomeCase {
  name: string;
  outcome: LinearDeliveryOutcome;
  wantStatus: number;
  wantNotified: number;
}

interface AckCase {
  name: string;
  outcome: LinearDeliveryOutcome;
  want?: { type: 'thought' | 'error'; body: RegExp };
}

function handedOver(): LinearDeliveryOutcome {
  return { handled: true, sessionId: 'session-1', issueIdentifier: 'JAR-7' };
}

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

function request(body: string, headers: Record<string, string>) {
  return { body: Buffer.from(body), headers };
}

function sessionBody(): string {
  return JSON.stringify({
    type: 'AgentSessionEvent',
    action: 'created',
    webhookTimestamp: Date.now(),
    agentSession: {
      id: 'session-1',
      issue: {
        id: 'issue-1',
        identifier: 'JAR-7',
        title: 'Test issue',
        url: 'https://linear.app/acme/issue/JAR-7/test-issue',
        team: { key: 'JAR' },
      },
    },
    promptContext: 'Do the thing.',
  });
}

function createFixture(
  options: { outcome?: LinearDeliveryOutcome; withToken?: boolean; ackFails?: boolean } = {},
): {
  context: LinearWebhookContext;
  delivered: LinearDelivery[];
  activities: Array<{ type: string; body: string }>;
  recorded: string[];
  notified(): number;
} {
  const config = loadConfig();
  const delivered: LinearDelivery[] = [];
  const activities: Array<{ type: string; body: string }> = [];
  const recorded: string[] = [];
  let notified = 0;

  const env: NodeJS.ProcessEnv = { [config.workflows.linearImplementer.webhookSecretEnv]: SECRET };
  if (options.withToken !== false)
    env[config.workflows.linearImplementer.apiTokenEnv] = 'lin_token';

  return {
    context: {
      config,
      store: recordingStore(store, recorded),
      env,
      fetchImpl: (async (_url: unknown, init?: { body?: string }) => {
        if (options.ackFails) throw new Error('linear api unreachable');
        const parsed = JSON.parse(init?.body ?? '{}') as {
          variables?: { input?: { content?: { type: string; body: string } } };
        };
        const content = parsed.variables?.input?.content;
        if (content) activities.push(content);
        return new Response(JSON.stringify({ data: { agentActivityCreate: { success: true } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
      deliver: (delivery) => {
        delivered.push(delivery);
        return Promise.resolve(options.outcome ?? handedOver());
      },
      notifyChanged: () => {
        notified += 1;
      },
    },
    delivered,
    activities,
    recorded,
    notified: () => notified,
  };
}

// auditingStore is the real store with the audit entries this surface writes made
// visible; every other write goes to the real database.
function recordingStore(real: Store, recorded: string[]): Store {
  return Object.assign(Object.create(real) as Store, {
    appendEvent: (input: { eventType: string }) => recorded.push(input.eventType),
  });
}
