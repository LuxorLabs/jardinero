import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type {
  GitHubDelivery,
  GitHubDeliveryOutcome,
} from '../../adapters/github/github-delivery.js';
import { loadConfig } from '../../config.js';
import type { Store } from '../../store/store.js';
import { createTestStore } from '../../testing/store.js';
import { type GitHubWebhookContext, githubWebhookResponse } from './github.js';

const SECRET = 'whsecret';

let store: Store;
let cleanup: () => void;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
});

afterEach(() => {
  cleanup();
});

describe('githubWebhookResponse', () => {
  const rejectionCases: RejectionCase[] = [
    {
      name: 'When the delivery carries no signature then should return error',
      signature: () => undefined,
      body: JSON.stringify({ action: 'created' }),
      want: { status: 401, error: 'invalid_signature' },
    },
    {
      name: 'When the signature does not match then should return error',
      signature: () => 'sha256=deadbeef',
      body: JSON.stringify({ action: 'created' }),
      want: { status: 401, error: 'invalid_signature' },
    },
    {
      // The HMAC is over the raw bytes, so an authentic delivery can still carry a
      // body nothing can read; that is a client error, not a forgery.
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

      const response = await githubWebhookResponse(
        fixture.context,
        request(testCase.body, signature ? { 'x-hub-signature-256': signature } : {}),
      );

      assert.equal(response.status, testCase.want.status);
      assert.deepEqual(response.body, { error: testCase.want.error });
      assert.deepEqual(fixture.delivered, []);
      assert.equal(fixture.notified(), 0);
    });
  }

  // Whether a delivery reached a machine is the adapter's answer; this surface turns
  // it into a status and a dashboard wake-up.
  const outcomeCases: OutcomeCase[] = [
    {
      name: 'When the delivery reaches a machine then should report it queued and wake the dashboard',
      outcome: { handled: true, reason: 'issue_comment' },
      wantStatus: 202,
      wantNotified: 1,
    },
    {
      name: 'When the delivery reaches nothing then should answer 200 without waking the dashboard',
      outcome: { handled: false, reason: 'event_ignored' },
      wantStatus: 200,
      wantNotified: 0,
    },
  ];

  for (const testCase of outcomeCases) {
    test(testCase.name, async () => {
      const fixture = createFixture({ outcome: testCase.outcome });
      const body = readyForReview();

      const response = await githubWebhookResponse(
        fixture.context,
        request(body, { 'x-hub-signature-256': sign(body), 'x-github-event': 'pull_request' }),
      );

      assert.equal(response.status, testCase.wantStatus);
      assert.deepEqual(response.body, {
        accepted: testCase.outcome.handled,
        reason: testCase.outcome.reason,
      });
      assert.equal(fixture.notified(), testCase.wantNotified);
    });
  }

  const passThroughCases: Array<{ name: string; headers: Record<string, string> }> = [
    {
      name: 'When the delivery names its event then should pass the name and payload on',
      headers: { 'x-github-event': 'pull_request' },
    },
    {
      // Nothing here decides what an event is, so a delivery without the header is
      // passed on as an empty name for the adapter to refuse.
      name: 'When the delivery names no event then should pass an empty name on',
      headers: {},
    },
  ];

  for (const testCase of passThroughCases) {
    test(testCase.name, async () => {
      const fixture = createFixture();
      const body = readyForReview();

      await githubWebhookResponse(
        fixture.context,
        request(body, { 'x-hub-signature-256': sign(body), ...testCase.headers }),
      );

      assert.deepEqual(fixture.delivered, [
        {
          eventName: testCase.headers['x-github-event'] ?? '',
          payload: JSON.parse(body) as Record<string, unknown>,
        },
      ]);
    });
  }

  // GitHub redelivers what it could not deliver, and a redelivered comment must not
  // put a second agent on the pull request.
  test('When the delivery was already handled then should report it duplicate', async () => {
    const fixture = createFixture();
    const body = readyForReview();
    const headers = {
      'x-hub-signature-256': sign(body),
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-1',
    };

    const first = await githubWebhookResponse(fixture.context, request(body, headers));
    const second = await githubWebhookResponse(fixture.context, request(body, headers));

    assert.equal(first.status, 202);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { accepted: false, reason: 'duplicate_delivery' });
    assert.equal(fixture.delivered.length, 1);
    assert.deepEqual(auditedTypes(store, 'orchestrator.webhook_already_handled'), [
      'orchestrator.webhook_already_handled',
    ]);
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
  outcome: GitHubDeliveryOutcome;
  wantStatus: number;
  wantNotified: number;
}

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

function auditedTypes(target: Store, type: string): string[] {
  return (
    target.queryReadOnly('SELECT event_type FROM event_log WHERE event_type = ?', [type]) as Array<{
      event_type: string;
    }>
  ).map((row) => row.event_type);
}

function request(body: string, headers: Record<string, string>) {
  return { body: Buffer.from(body), headers };
}

function readyForReview(): string {
  return JSON.stringify({
    action: 'ready_for_review',
    repository: { full_name: 'acme/web.app' },
    pull_request: { number: 1, draft: false, user: { login: 'acme-jardinero[bot]' } },
  });
}

function createFixture(options: { outcome?: GitHubDeliveryOutcome } = {}): {
  context: GitHubWebhookContext;
  delivered: GitHubDelivery[];
  notified(): number;
} {
  const config = loadConfig();
  const delivered: GitHubDelivery[] = [];
  let notified = 0;

  return {
    context: {
      config,
      store,
      env: { [config.githubApp.webhookSecretEnv]: SECRET },
      deliver: (delivery) => {
        delivered.push(delivery);
        return Promise.resolve(options.outcome ?? { handled: true });
      },
      notifyChanged: () => {
        notified += 1;
      },
    },
    delivered,
    notified: () => notified,
  };
}
