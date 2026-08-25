import type { AgentActivityContent } from '../../adapters/linear/linear-api.js';
import { createAgentActivity } from '../../adapters/linear/linear-api.js';
import type {
  LinearDelivery,
  LinearDeliveryOutcome,
} from '../../adapters/linear/linear-delivery.js';
import type { AppConfig } from '../../config.js';
import { parseJsonObject } from '../../platform/json.js';
import { nowMs } from '../../platform/time.js';
import type { Store } from '../../store/store.js';
import { type RawRequest, headerValue } from '../request.js';
import type { HandlerResponse } from '../respond.js';
import { verifyLinearSignature } from './linear-signature.js';

export interface LinearWebhookContext {
  config: AppConfig;
  store: Store;
  deliver(delivery: LinearDelivery): Promise<LinearDeliveryOutcome>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  notifyChanged(): void;
}

// LINEAR_DELIVERY_GUARD_TTL_MS doubles Linear's ~60s HMAC replay tolerance, so a
// delivery id outlives any window in which Linear would retry it.
const LINEAR_DELIVERY_GUARD_TTL_MS = 120_000;

// linearWebhookResponse verifies the HMAC over the raw body, hands the delivery on,
// and acknowledges the session: Linear marks one unresponsive unless
// an activity lands within 10 seconds, sooner than a run can report anything.
export async function linearWebhookResponse(
  context: LinearWebhookContext,
  request: RawRequest,
): Promise<HandlerResponse> {
  const body = request.body;
  const secret = (context.env ?? process.env)[
    context.config.workflows.linearImplementer.webhookSecretEnv
  ];
  const signature = headerValue(request.headers['linear-signature']);
  if (!verifyLinearSignature(secret, body, signature ?? null)) {
    return { status: 401, body: { error: 'invalid_signature' } };
  }

  // A redelivery of an authentic delivery must not act twice or re-fire the
  // session ack; the durable table also covers a restart inside the replay
  // window. Deliveries without the header are processed normally.
  const deliveryId = headerValue(request.headers['linear-delivery']);
  if (
    deliveryId &&
    !context.store.recordWebhookDelivery(
      'linear',
      deliveryId,
      LINEAR_DELIVERY_GUARD_TTL_MS,
      body.toString('utf8'),
    )
  ) {
    context.store.appendEvent({
      eventType: 'orchestrator.webhook_already_handled',
      metadata: {
        provider_name: 'linear',
        provider_delivery_id: deliveryId,
      },
    });
    return { status: 200, body: { accepted: false, reason: 'duplicate_delivery' } };
  }

  let payload: Record<string, unknown>;
  try {
    payload = parseJsonObject(body.toString('utf8'));
  } catch {
    return { status: 400, body: { error: 'invalid_json_body' } };
  }

  const outcome = await context.deliver({ payload, nowMs: nowMs() });
  if (outcome.handled) context.notifyChanged();
  ackLinearSession(context, outcome);
  return {
    status: outcome.handled ? 202 : 200,
    body: { accepted: outcome.handled, reason: outcome.reason },
  };
}

// ackLinearSession tells the delegating person what happened. Best effort: a failed
// ack must not fail the delivery, so it fires without awaiting and audits errors.
function ackLinearSession(context: LinearWebhookContext, outcome: LinearDeliveryOutcome): void {
  const sessionId = outcome.sessionId;
  if (!sessionId) return;
  const content = linearAckContent(outcome);
  if (!content) return;
  const token = (context.env ?? process.env)[
    context.config.workflows.linearImplementer.apiTokenEnv
  ];
  if (!token) {
    context.store.appendEvent({
      eventType: 'orchestrator.linear_reply_skipped',
      metadata: {
        session_id: sessionId,
        reason: 'missing_api_token',
      },
    });
    return;
  }
  void createAgentActivity({
    sessionId,
    content,
    token,
    fetchImpl: context.fetchImpl,
  }).catch((error: unknown) => {
    context.store.appendEvent({
      eventType: 'orchestrator.linear_reply_failed',
      metadata: {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  });
}

// linearAckContent is what the delegating person reads in Linear seconds after
// asking.
function linearAckContent(outcome: LinearDeliveryOutcome): AgentActivityContent | undefined {
  const issue = outcome.issueIdentifier ?? 'the issue';
  if (outcome.handled) {
    return {
      type: 'thought',
      body: `Picked up ${issue} for implementation. I will report back here with a pull request or an outcome.`,
    };
  }
  switch (outcome.reason) {
    case 'no_repo_for_team':
      return {
        type: 'error',
        body: 'No repository is configured for this team; an operator must add it to workflows.linearImplementer.team_repos before I can implement issues here.',
      };
    case 'prompted_not_supported':
      return {
        type: 'thought',
        body: 'Follow-up prompts are not supported yet; comment on the pull request instead and PR maintenance will pick it up.',
      };
    // Everything else is a delivery that was never about work, so the person who
    // is waiting is told nothing.
    default:
      return undefined;
  }
}
