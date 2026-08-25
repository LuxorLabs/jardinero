# Operator dashboard

A React SPA under [`web/`](../web), built into `dist/public` and served by the Jardinero process. Jardinero has no login of its own: put an authenticating reverse proxy in front of it, and it reads the identity that proxy sets on the request. It understands the headers Pomerium and oauth2-proxy set, and records which of them answered. Conventional headers like `x-forwarded-email` are ignored on purpose: any client can send one, and a forged identity in the audit trail is worse than none. The admin bearer token never reaches browser JavaScript.

## Running it

```bash
make install
make dev                  # API on :3000
```

Open `http://localhost:3000/dashboard`. For frontend work with hot reload, run `make dev` and `make dev-web` side by side; the Vite dev server proxies `/dashboard/api` to `:3000`.

To look at the UI without the stack, `make preview` builds the SPA and boots only the HTTP server on `http://127.0.0.1:4178/dashboard`, against a throwaway database seeded so every tab has something to show. Point `PREVIEW_DATA_DIR` at a real data directory to browse that instead.

In a Tenki orchestrator sandbox the dashboard is exposed through a preview URL at startup and the URL is logged. `DASHBOARD_EXPOSE_ON_STARTUP=false` disables it; `DASHBOARD_EXPOSE_SLUG` and `DASHBOARD_EXPOSE_TTL_MINUTES` are optional. Exposing the port also makes `/admin/*` and `/capsule/*` reachable, so they stay bearer-protected.

## Pages

Every page is the same shell with a different tab; a deep link renders that tab directly.

| Page | Answers |
|------|---------|
| `/dashboard` | what each workflow is holding, what it produced in the window, and what needs a person |
| `/dashboard/operation` | every open instance, and what happened inside one: its runs, their artifacts, its timeline |
| `/dashboard/requests` | who asked for what, and what became of the ask |
| `/dashboard/prs` | the pull requests we opened or follow, and how they ended |
| `/dashboard/events` | the event log, filterable |
| `/dashboard/prompts` | the prompt of each agent, and the guidance an operator may override |

## API

Reads:

- `GET /dashboard/api/session` — the header snapshot: version, sandboxes running against the cap, open instances, how many need a person.
- `GET /dashboard/api/overview?window=24h|7d|30d` — the workflows with their states, the four metrics as a series, the attention queue, recent failures and recent pull requests.
- `GET /dashboard/api/workflow-instances` — filterable by `workflow_type`, `workflow_state`, `subject`, `attention`, `window`; paged with `limit` and `cursor`.
- `GET /dashboard/api/workflow-instances/{workflowType}/{id}` — one instance with its fields, its sandbox runs, its events and the asks that reached it.
- `GET /dashboard/api/sandbox-runs/{id}` and `.../artifacts/{name}` — one run with its events and its files.
- `GET /dashboard/api/requests`, `GET /dashboard/api/pull-requests`, `GET /dashboard/api/events` — the three list views, all paged the same way.
- `GET /dashboard/api/agents` — each agent's prompt as ordered segments, the known repositories, and the stored overrides.

Writes, all of them audited as `operator.dashboard_write_requested` with the proxy identity when it is present:

- `POST /dashboard/api/sandbox-runs/{id}/kill` — abort a sandbox that is executing; `409` when it is not.
- `POST /dashboard/api/workflow-instances/{workflowType}/{id}/retry` — hand an instance waiting for a person back to its workflow.
- `POST /dashboard/api/agents/instructions` and `.../instructions/delete` — save or drop guidance. Both need `confirmed: true` and, on an entry that already exists, its current `revision` (`409` on mismatch).

Raw SQL is not reachable from a dashboard route. `/admin/*` and `/capsule/*` still require `Authorization: Bearer <token>`.

## Live updates

The SPA opens an `EventSource` on `/dashboard/api/stream`. The stream sends `dashboard.connected`, then a `dashboard.snapshot` whenever the operator surface changes; it re-checks every two seconds, so a change written by a worker or straight into the database shows up too.

The browser also polls every five seconds as a fallback. If the stream is unavailable the live indicator says so and the page keeps refreshing; nothing needs a manual reload.

## Limits worth knowing

- Live updates are process-local. A horizontally scaled deployment would need sticky sessions or a shared bus.
- Access is whatever the proxy in front allows, and there are no roles of its own: anyone who reaches the dashboard can operate it.
- Run payloads, summaries and errors are shown with secrets redacted by key and by common token shapes, which is not a guarantee: keep credentials out of free-form agent summaries.
