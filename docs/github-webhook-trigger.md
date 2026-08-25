# GitHub Webhook Trigger

The orchestrator receives GitHub events directly as a GitHub App webhook. There is no per-repo GitHub Actions workflow to install: the App is configured once at the org/installation level and delivers events for every repo it is installed on. The persistent orchestrator's HTTP server exposes the receiver; the PR-maintenance poll (`workflows.pr_maintainer.poll_interval_min`) stays on as a backstop for deliveries missed while the orchestrator is down.

## Receiver

`POST /webhooks/github` on the orchestrator's public ingress (same host/port as the dashboard, `server.host:server.port`).

- Authenticated by the webhook secret: GitHub signs the raw body with HMAC-SHA256 and sends `x-hub-signature-256`. A missing or wrong signature is rejected with `401` and no run is dispatched.
- The event type comes from `x-github-event`, the delivery id from `x-github-delivery`. A delivery id already seen is dropped, so a GitHub redelivery does not open the work twice.
- A verified delivery is translated by `github-delivery.ts` into an entry point on the workflow that owns the subject; the adapter decides nothing beyond which one that is.

## GitHub App configuration

Set these once on the App:

- **Webhook URL**: `https://<orchestrator-host>/webhooks/github`
- **Webhook secret**: the value of `JARDINERO_AGENT_WEBHOOK_SECRET`
- **Subscribed events**: `Pull requests`, `Pull request reviews`, `Pull request review comments`, `Issue comments`, `Check suites`, `Deployment statuses`. This list is the one in `github-delivery.ts`, and it is the trap: handling a new event type in code does nothing until the App is subscribed to it, and there is no error to see.

The App already mints installation tokens for the worker (see [`secrets.md`](secrets.md)); the same App carries the webhook. Reactions and replies need write on Pull requests and Issues.

## Local testing

Forward deliveries to a local orchestrator with any GitHub-webhook tunnel (e.g. `gh webhook forward --events issue_comment --url http://localhost:3000/webhooks/github`), or replay a saved payload with `curl`, signing the body with the same secret:

```bash
body='{"action":"created", ...}'
sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$JARDINERO_AGENT_WEBHOOK_SECRET" | awk '{print $2}')"
curl -sS http://localhost:3000/webhooks/github \
  -H "x-github-event: issue_comment" \
  -H "x-hub-signature-256: $sig" \
  -H 'content-type: application/json' \
  -d "$body"
```
