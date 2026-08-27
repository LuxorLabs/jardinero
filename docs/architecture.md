# Architecture

Jardinero is a TypeScript/Node control plane for autonomous engineering agents. It receives events (GitHub, Linear, cron, the operator), turns each one into work it can track, runs that work in ephemeral Tenki sandboxes or Persistent Freestyle VMs that run Codex, verifies what those agents produce, and shows an operator what happened.

Everything runs in one process, over one SQLite database.

This document is the runtime shape. The engine that decides what happens next has its own doc: [`workflow-engine/README.md`](workflow-engine/README.md), which is where the five workflows, their states and the end-to-end flows are drawn. Other subsystems: [`dashboard.md`](dashboard.md), [`secrets.md`](secrets.md), [`../tenki-images/README.md`](../tenki-images/README.md).

## Components

```
Jardinero process
│
├── Config                   src/config.ts + the file at CONFIG_PATH
│
├── Transport                src/transport/
│   ├── /health
│   ├── /dashboard           operator SPA shell; browser auth belongs to the proxy
│   ├── /dashboard/api/*     JSON + SSE for the SPA
│   ├── /admin/*             admin-token triggers and preflight
│   ├── /capsule/*           read-only runs, event streams, SQL
│   └── /webhooks/github|linear|discord
│
├── Adapters                 src/adapters/
│   ├── github/              deliveries in, pull-request reads and writes out
│   ├── linear/              deliveries in, session and issue-state writes out
│   ├── tenki/               sandbox scope and the reaper for leaked sandboxes
│   ├── codex/, grafana/     auth and MCP plumbing for the agent
│   └── discord/             interactions in, messages and threads out
│
├── Orchestrator             src/orchestrator/
│   ├── state-machines/      one per workflow; the only place that decides
│   ├── engine-commands.ts   the only seam transport has into them
│   ├── sandbox-pool.ts      caps, kill, run lifecycle
│   ├── scheduler.ts         cron scans, PR polling, backups, reaper
│   └── worker/              the WorkerRunner boundary: Tenki, Freestyle or Mock
│
└── Store                    src/store/ + db/schema.sql
    ├── SQLite data/state.db (WAL, foreign keys on)
    └── artifacts            per-run files under data/runs/
```

## Boot

`src/index.ts` wires it in this order:

1. `loadConfig()`, then the Loki log sink if it is enabled.
2. The GitHub App token refresher for either real worker runner, and the Linear one when the LinearImplementer workflow is on. A failed Linear mint degrades to skipped write-backs instead of killing the process.
3. `new Store(config.store)` and `store.initializeAfterBoot()`: open SQLite, apply `db/schema.sql`, and reconcile sandbox runs a crashed process left `running` into `orphaned`.
4. `createWorkerRunner(config)`: the configured Tenki, Freestyle or mock runner.
5. `new Orchestrator({...})`, which builds the pool and the five workflow engines, then `createEngineCommands(...)` over it.
6. `new Scheduler(...)` and `createApiServer(...)`.
7. `orchestrator.start()`: recover every open instance, then start the periodic check.
8. `server.listen(...)` and `scheduler.start()`.

`unhandledRejection` and `uncaughtException` log the stack and exit non-zero so the supervisor restarts the process; the next boot reconciles what was in flight. `SIGTERM`/`SIGINT` stop the scheduler, abort the sandboxes in flight and wait for them to record how they ended, then close the server and the store.

## How work flows

```
GitHub / Linear / cron / operator
        ↓
adapter                       translates, decides nothing
        ↓
EngineCommands                the only entry into the workflows
        ↓
workflow entry point          takes the instance under a lock, switches on its state
        ↓
state handler                 starts a sandbox run and returns the next state
        ↓
SandboxPool → WorkerRunner → provider VM + Codex
        ↓
run succeeded / failed        back into the workflow, which decides what is next
```

Worth knowing before changing this path:

- **The workflow decides, nothing else.** An adapter that starts to branch on a workflow state is in the wrong place; the decision belongs in `state-handlers.ts`.
- **Caps live in the pool, not in the workflows.** A run the caps refuse is refused, not queued: the instance stays in its `*_pending` state and the periodic check asks again.
- **An instance is durable, a pool is not.** After a restart, an instance in `*_pending` with no live run is what recovery walks; that is why every workflow has that state.
- **Unknown Codex cost is `NULL`, not `0`.** Don't treat a missing cost as free.
- **Shared response types** between the server and the SPA live in `src/transport/dashboard/dashboard-api-types.ts`. Change both sides together.

## Tables

Defined in [`db/schema.sql`](../db/schema.sql), all `CREATE ... IF NOT EXISTS`.

| Table | Holds |
|-------|-------|
| `request_router`, `linear_implementer`, `fix_implementer`, `pr_maintainer`, `log_reviewer` | one row per instance of that workflow, with its state and the context it needs |
| `pr_maintainer_thread` | how many times we answered each review thread |
| `sandbox_run` | one execution: which agent ran, for which instance, how it ended, what it cost |
| `event_log` | what happened, for a person to read; never read to decide anything |
| `repository` | the repos the instances point at |
| `webhook_delivery` | delivery ids already seen, so a redelivery is dropped |
| `prompts` | operator guidance per repo and agent kind, replacing the editable segment of the built-in prompt |

Three partial unique indexes stop two open instances existing for the same Linear issue, the same finding fingerprint, or the same repository and PR number.

Per-run artifacts live under `data/runs/<sandbox_run_id>/`. Backups run on `store.backup_interval_min` keeping `store.backup_retention_count` locally.

## The worker boundary

All execution goes through one interface, so the orchestrator never learns how an agent actually runs:

```ts
interface SandboxRunner {
  run(context: SandboxRunContext): Promise<WorkerResult>;
}
```

`createWorkerRunner(config)` returns the Tenki runner (`worker.runner: "tenki"`), the Freestyle runner (`"freestyle"`) or the mock one (`"mock"`, for local smoke tests). Both real runners pick the image for the run's repo (`worker.repos[repo].image`, else `worker.default.image`), clone the repo under `worker.workspace_path`, write the prompt and task, forward Codex auth and, for a scan, the Grafana MCP credentials, run Codex while streaming events back, and parse what came out: cost, the PR it opened, the findings it reported, or a verifier verdict. A side effect is checked against the run's repo, branch and agent commit trailer before it is trusted. Freestyle's five-minute one-shot execution limit is avoided for Codex by using a persistent PTY session and streaming its combined terminal output; every VM also receives a hard TTL beyond the run deadline, so a process crash does not leave it running indefinitely.

## Observability

- **Logs**: `HH:MM:SS.mmm LEVEL [scope] message key=value`, scoped per subsystem (`boot`, `scheduler`, `http`, `store`, `worker`, `sandbox-pool`, `periodic-check`, `run-outcome`, `boot-recovery`, `reaper`). `LOG_LEVEL` and `NO_COLOR` control them; with `observability.loki.enabled` they are also shipped to Loki.
- **`event_log`**: the durable record of transitions, sandbox events and operator writes. This is where counts and history come from; there are no Prometheus series of our own.
- **Dashboard**: the SPA under `web/` reads `/dashboard/api/*` plus an SSE stream. See [`dashboard.md`](dashboard.md).
