import type {
  GitHubDelivery,
  GitHubDeliveryOutcome,
} from '../../adapters/github/github-delivery.js';
import type { AppConfig } from '../../config.js';
import { parseJsonObject } from '../../platform/json.js';
import type { Store } from '../../store/store.js';
import { headerValue, type RawRequest } from '../request.js';
import type { HandlerResponse } from '../respond.js';
import { verifyGitHubSignature } from './github-signature.js';

export interface GitHubWebhookContext {
  config: AppConfig;
  store: Store;
  deliver(delivery: GitHubDelivery): Promise<GitHubDeliveryOutcome>;
  env?: NodeJS.ProcessEnv;
  // Wakes the dashboard's event stream; injected so the receiver never reaches
  // back into the server module that routes to it.
  notifyChanged(): void;
}

// GITHUB_DELIVERY_GUARD_TTL_MS is how long a delivery id stays remembered, long
// enough for a GitHub retry to find it already handled.
const GITHUB_DELIVERY_GUARD_TTL_MS = 15 * 60_000;

// githubWebhookResponse verifies the HMAC over the raw body and hands the delivery on.
export async function githubWebhookResponse(
  context: GitHubWebhookContext,
  request: RawRequest,
): Promise<HandlerResponse> {
  const secret = (context.env ?? process.env)[context.config.githubApp.webhookSecretEnv];
  const signature = headerValue(request.headers['x-hub-signature-256']);
  if (!verifyGitHubSignature(secret, request.body, signature ?? null)) {
    return { status: 401, body: { error: 'invalid_signature' } };
  }

  const deliveryId = headerValue(request.headers['x-github-delivery']);
  if (
    deliveryId &&
    !context.store.recordWebhookDelivery(
      'github',
      deliveryId,
      GITHUB_DELIVERY_GUARD_TTL_MS,
      request.body.toString('utf8'),
    )
  ) {
    context.store.appendEvent({
      eventType: 'orchestrator.webhook_already_handled',
      metadata: {
        provider_name: 'github',
        provider_delivery_id: deliveryId,
      },
    });
    return { status: 200, body: { accepted: false, reason: 'duplicate_delivery' } };
  }

  let payload: Record<string, unknown>;
  try {
    payload = parseJsonObject(request.body.toString('utf8'));
  } catch {
    return { status: 400, body: { error: 'invalid_json_body' } };
  }

  const outcome = await context.deliver({
    eventName: headerValue(request.headers['x-github-event']) ?? '',
    payload,
  });
  if (outcome.handled) context.notifyChanged();
  return {
    status: outcome.handled ? 202 : 200,
    body: { accepted: outcome.handled, reason: outcome.reason },
  };
}
