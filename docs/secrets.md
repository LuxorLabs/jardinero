# Credentials

Every credential Jardinero needs, what it is for, and where to get it. None of them belong in the repository: the config names the environment variables, never their values. Copy [`.env.example`](../.env.example) to `.env` for local development, and inject the same names however your deployment injects secrets.

Ask what is still missing at any time:

```bash
curl -s localhost:3000/setup | jq
```

## Always required

| Variable | What it is |
|---|---|
| `ORCHESTRATOR_ADMIN_TOKEN` | Bearer token for `/admin/*` and `/capsule/*`. Any random string you generate. Those routes fail closed when it is unset. |

## GitHub

Jardinero authenticates as a GitHub App you create and install. It mints an installation token at runtime and re-mints it on the timer in `github_app.token_refresh_min`, so there is no personal access token to provision.

| Variable | What it is |
|---|---|
| `JARDINERO_AGENT_APP_ID` | The App's id, on its settings page. |
| `JARDINERO_AGENT_INSTALL_ID` | The installation the token is minted for. It is the trailing number in the URL of the App's installation settings. |
| `JARDINERO_AGENT_PRIVATE_KEY` | The PEM the App signs its JWT with. Generate it on the App page; you get one chance to download it. |
| `JARDINERO_AGENT_WEBHOOK_SECRET` | A random string you choose. Set the same value in the App's webhook configuration; the `/webhooks/github` receiver verifies every delivery against it. |

Reacting and replying needs write on Pull requests and Issues. Which events the App has to be subscribed to is in [`github-webhook-trigger.md`](github-webhook-trigger.md), and it is the trap: handling an event in code does nothing until the App subscribes to it, and nothing reports the gap.

## Tenki

| Variable | What it is |
|---|---|
| `TENKI_API_KEY` | Your Tenki API key. Only optional when the runtime supplies ambient SDK auth to the process. |
| `TENKI_API_URL` | Only to override the SDK default. |
| `TENKI_WORKSPACE_ID` | Required for a service token that spans workspaces; startup refuses rather than let the server pick. A workspace API key carries its own workspace, and the server infers it. |

## Freestyle

Only when `worker.runner` is `freestyle`.

| Variable | What it is |
|---|---|
| `FREESTYLE_API_KEY` | A permanent Freestyle API key from the dashboard. The runner creates, resizes and deletes worker VMs with it. |
| `FREESTYLE_API_URL` | Optional API base URL override. Leave it unset for Freestyle's public API. |

## Daytona

Only when `worker.runner` is `daytona`.

| Variable | What it is |
|---|---|
| `DAYTONA_API_KEY` | A Daytona API key from the dashboard. The runner creates and deletes worker sandboxes with it. |
| `DAYTONA_API_URL` | Optional API base URL override. Leave it unset for Daytona's public API. |

## Codex

`worker.codex_auth_mode` picks which of these applies.

| Mode | What it needs |
|---|---|
| `capsule` (default) | `~/.codex/auth.json` on the host running Jardinero. Run `codex login` there once. The runner forwards that file into each sandbox at `/home/tenki/.codex/auth.json`, mode `0600`. |
| `access_token` | `CODEX_ACCESS_TOKEN`, for trusted non-interactive automation. |
| `api_key` | `OPENAI_API_KEY`, to bill through the OpenAI Platform instead of a ChatGPT/Codex subscription. |

### Keeping capsule auth alive

Capsule mode needs something to rotate that `auth.json`, and it is not optional: left alone it stops working, in a way that is hard to read from the symptoms.

The file is forwarded into every worker sandbox, and OpenAI revokes the old `refresh_token` the moment a new one is issued. Codex only rotates once the `access_token` has expired, so the first sandbox to reach that expiry rotates, takes the new bundle to its grave when it is destroyed, and leaves the stored one revoked. Every run after that fails until someone runs `codex login` again by hand.

Rotating on a schedule avoids it entirely: refresh well inside the token's lifetime and no sandbox ever reaches the expiry.

```bash
pnpm run codex:refresh
```

That rewrites `~/.codex/auth.json` in place with a freshly minted bundle, which is the one file the runner forwards into sandboxes. Scheduling it is yours: a cron entry, a systemd timer, a Kubernetes CronJob, whatever runs things where Jardinero runs. Every two days is far inside the token's lifetime, and a missed run costs nothing.

One case needs more than the timer. If your `auth.json` is injected from a secret store on every start, rewriting the file on disk is not enough: the next restart hands back the token this run revoked. There, the schedule has to write the refreshed file back to the store as well, and `scripts/refresh-codex-auth.ts` is the piece to call from whatever does that.

## Linear

Only when `workflows.linear_implementer.enabled` is true.

| Variable | What it is |
|---|---|
| `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` | Your Linear OAuth app's credentials. Jardinero exchanges them for an app-actor token with the `client_credentials` grant and re-mints it on `workflows.linear_implementer.token_refresh_min`, so there is no token to provision by hand. **Linear has to enable that grant on your app; it is not self-service.** |
| `LINEAR_WEBHOOK_SECRET` | The signing secret from the app's webhook configuration. The `/webhooks/linear` receiver verifies deliveries against it. |

## Discord

Only when `discord.enabled` is true.

| Variable | What it is |
|---|---|
| `DISCORD_APPLICATION_ID` | The application the bot belongs to. |
| `DISCORD_PUBLIC_KEY` | Its Ed25519 public key, which interaction signatures verify against. |
| `DISCORD_BOT_TOKEN` | The bot token, for the channel and thread routes. |
| `DISCORD_GUILD_ID` | Read only by `pnpm run discord:register`, and only when `--guild` is not passed. |

Which roles may run the commands, which channel belongs to which repository, and who is the same person across Discord, GitHub and Linear are policy rather than secrets, so they live in the config: `discord.allowed_role_ids`, `discord.repo_channels` and `people`.

## Grafana

Only when `workflows.log_reviewer.enabled` and `mcp.grafana.enabled` are true. Log access is a remote MCP integration, and the default is a service account.

```yaml
mcp:
  grafana:
    enabled: true
    url: https://<your-grafana-mcp-host>/mcp
    auth: service_account
    service_account_token_env: GRAFANA_SA_TOKEN
```

Create the service account token in Grafana and put the `glsa_...` value in `GRAFANA_SA_TOKEN`. Jardinero passes that variable into log-review sandboxes and configures Codex with `bearer_token_env_var`, so the token itself never reaches the config.

Browser OAuth also works. Switch `auth` and `url`, and bootstrap the grant once in an interactive Codex profile:

```yaml
mcp:
  grafana:
    auth: oauth
    client_id_env: GRAFANA_CLIENT_ID
    access_token_env: GRAFANA_ACCESS_TOKEN
    refresh_token_env: GRAFANA_REFRESH_TOKEN
```

```bash
codex mcp add grafana --url https://<your-grafana-mcp-host>/mcp
codex mcp login grafana
codex mcp list
```

Then set `GRAFANA_CLIENT_ID`, `GRAFANA_ACCESS_TOKEN` and `GRAFANA_REFRESH_TOKEN` from the result. For each log-review worker Jardinero writes a Codex `.credentials.json` into the sandbox, so workers never need a browser.

Treat the service account token and the refresh token as credentials, and rotate either after exposure.

## Per-repository credentials

A repository whose own checks need a secret names the variables in `worker.repos.<repo>.secret_envs`. The runner reads each name from Jardinero's environment and sets it in that repository's sandboxes; the config holds names, never values.

It is off unless a repository asks for it. A name whose value is missing is left unset in the sandbox rather than passed through as an empty string, and preflight warns about it at boot.

## Running it

Keep secrets out of the repository and inject them at start. Environment injection from your platform, or a secret manager fetched by a bootstrap command, both work. If you write a secrets file, keep it outside the checkout, point `ENV_FILE` at it, and delete it when the process stops.

Existing environment variables always win over anything in `.env`.
