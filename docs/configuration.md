# Configuration

Runtime configuration is loaded from `CONFIG_PATH`, falling back to the in-repo
`config/local.yaml`. The loaded file is the whole config: there is no merge across
files, so whatever it sets is the complete value, with per-key code defaults filling
anything omitted.

Credentials never live in the config. They are read from the process environment
and, for local development, from `.env`. The config holds the *names* of the
environment variables, never their values. See [`secrets.md`](secrets.md).

## Workers

`worker.runner` is `mock`, `tenki` or `freestyle`. `mock` dispatches nothing and is the default, which is what makes the repository runnable with no accounts at all. Both real runners require `worker.default.image`; without one, boot fails rather than failing opaquely on the first run. A Tenki image is a registry ref, while a Freestyle image is a snapshot id, your snapshot slug or a public `owner/slug`.

Per-repository overrides win for a matching run repository:

```yaml
worker:
  runner: "freestyle"
  default:
    image: "jardinero-default"
  repos:
    your-org/your-repo:
      image: "<your-registry>/your-repo:<tag>"
      resources: { cpu_cores: 8, memory_mb: 16384 }
```

Worker files are written under `worker.workspace_path`, which defaults to `/home/tenki/workspace`. The Freestyle runner creates the `tenki` user when a VM starts so the same prepared image and Codex-auth layout work with either provider.

`worker.freestyle_api_key_env` defaults to `FREESTYLE_API_KEY`. `worker.freestyle_api_url_env` defaults to `FREESTYLE_API_URL` and is only needed for an API endpoint override. Freestyle VMs receive outbound Internet access, the configured CPU and memory floor, the run metadata, and a TTL five minutes beyond Jardinero's wall-clock deadline. `worker.sandbox_reaper_interval_min` is Tenki-only because that provider exposes workspace-wide reconciliation; the Freestyle TTL is its crash-cleanup backstop.

### Model auth

`worker.codex_auth_mode` picks how the agent authenticates:

- `capsule` (default) forwards the host's `~/.codex/auth.json` into each sandbox.
  Run `codex login` on the host first. No API key needed.
- `access_token` uses `CODEX_ACCESS_TOKEN`, for trusted non-interactive automation.
- `api_key` uses `OPENAI_API_KEY`, for OpenAI Platform billing instead of a
  ChatGPT/Codex subscription.

Codex runs default to `worker.codex_bypass_sandbox: true`, using the provider VM as the sandbox boundary so the agent can branch, commit and open pull requests inside its clone.

### Models and effort

Each seat picks a reasoning effort for its job, and its model comes from the run
repository's generation, rather than paying flagship rates everywhere. A
repository's image fixes its generation (`worker.repos.<repo>.model.generation`, or
`worker.default.model` for anything unmapped). Within a generation, the coding,
planning and validation seats run the `implementation` tier and the high-volume
triage seat runs the `triage` tier, both defined in `worker.model_generations`.

Effort is set per seat (`worker.implementation_*`, `worker.triage_*`,
`workflows.linear_implementer.verify_*`) and clamped to the repository's
`max_effort`. It reaches the Codex CLI as `-c model_reasoning_effort`. Valid values
are `low`, `medium`, `high`, `xhigh` and `max`.

Codex does not always report cost. A run with no parseable USD cost keeps
`cost_usd` at `NULL`, and cost-budget enforcement is skipped for it rather than
treating unknown cost as free.

## Linear routing

`workflows.linear_implementer.team_repos` maps a Linear team to the repository its
tickets are implemented in. A team that works in one repository maps straight to it:

```yaml
workflows:
  linear_implementer:
    team_repos:
      ENG: "your-org/your-repo"
```

A team that spans repositories uses an object with a `default`, an optional `repos`
list selected by an explicit GitHub reference in the ticket, and `projects`, keyed
by Linear project name or id:

```yaml
      PLATFORM:
        default: "your-org/api"
        repos:
          - "your-org/worker"
        projects:
          "Billing": "your-org/billing"
```

Routing happens before the sandbox is created. An explicit GitHub reference in the
ticket wins when it names exactly one configured repository for the team, then the
project mapping, then the team default. An unknown or ambiguous reference falls
through instead of failing.

## Log review

`workflows.log_reviewer` is off by default. When enabled, it scans the targets in
`workflows.log_reviewer.repos`, one entry per repository and namespace:

```yaml
workflows:
  log_reviewer:
    enabled: true
    repos:
      - repo: "your-org/your-repo"
        namespace: "production"
        clusters: ["your-cluster"]
        services: ["api", "worker"]
```

The cron opens one scan per target. `POST /admin/trigger/log-review` does the same
and narrows with `repo=<owner/name>` and `namespace=<ns>`. Those repositories, plus
every repository named in the Linear routing, are registered at boot so an instance
always has a repository row to point at.

Log access is a remote Grafana MCP server configured under `mcp.grafana`. This
workflow is Grafana plus Loki plus Kubernetes; there is no adapter for another
telemetry stack.

## Operator API

Two routes carry no auth, because both answer about the instance rather than about
its data, and both are useful before anything is configured:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/setup
```

`/setup` is the preflight report: every credential the running configuration needs,
and whether it is there. It says whether something is configured and never what it
is, so it carries no hostname, path or credential value.

Everything under `/admin/*` and `/capsule/*` requires
`Authorization: Bearer $ORCHESTRATOR_ADMIN_TOKEN`, and fails closed when the token
is unset. `/capsule/sql` runs read-only SQL over the whole database, which is why.

```bash
curl -H "Authorization: Bearer $ORCHESTRATOR_ADMIN_TOKEN" \
  http://localhost:3000/admin/preflight
curl -H "Authorization: Bearer $ORCHESTRATOR_ADMIN_TOKEN" \
  -X POST http://localhost:3000/admin/trigger/log-review
curl -H "Authorization: Bearer $ORCHESTRATOR_ADMIN_TOKEN" \
  http://localhost:3000/capsule/runs
```

## Logging

Every line is `HH:MM:SS.mmm LEVEL [scope] message key=value …`, in UTC, matching the
stored event timestamps. Scopes map to subsystems: `boot`, `scheduler`, `http`,
`store`, `sandbox-pool`, `worker`, `periodic-check`, `boot-recovery`.

`LOG_LEVEL` is `debug | info | warn | error | silent`, default `info`. `debug` also
shows health probes, per-run timing and raw `codex.*` events. `NO_COLOR=1` disables
ANSI colors when piping to a file.
