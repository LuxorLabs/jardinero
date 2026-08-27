# Setup

From a fresh clone to an agent opening a pull request in your repository.

Read it in order. Each step ends with something you can run, so a mistake is caught where it was made rather than three steps later.

This is the procedure. What every configuration key means is the reference, [`configuration.md`](configuration.md); what every credential is and where it comes from is [`secrets.md`](secrets.md).

## Everything you have to do

| | What you do | Needed for |
|---|---|---|
| 1 | Run it on your machine | everything |
| 2 | Set up Tenki or Freestyle | everything |
| 3 | Install Codex | everything |
| 4 | Build a worker image for your repository | everything |
| 5 | Put it behind a public URL | everything |
| 6 | Create a GitHub App | everything |
| 7 | Connect Linear | tickets |
| 8 | Connect Discord | driving it from chat |
| 9 | Turn on log review | log review |

Steps 1 to 6 are the floor. Nothing happens before step 6, because every workflow ends in a pull request and that needs the GitHub App. Steps 7 to 9 add a way in; skip any you do not want.

From step 1 on, this says what is still missing:

```bash
curl -s localhost:3000/setup | jq
```

Before any of it, look around with no accounts and nothing installed but Node 24 and pnpm:

```bash
make install
make preview
```

That serves a mock dashboard on <http://127.0.0.1:4178/dashboard> against a throwaway database of invented work. Nothing runs behind it.

## 1. Run it

Copy the template, and set the one value that has to be set before it runs:

```bash
cp .env.example .env
```

| Variable | What to put in it |
|---|---|
| `ORCHESTRATOR_ADMIN_TOKEN` | Any random string, e.g. `openssl rand -hex 32`. It is the bearer token for `/admin/*` and `/capsule/*`, and those routes refuse everything until you replace the template value. |

Then run it:

```bash
make install
make dev
```

The dashboard is at <http://localhost:3000/dashboard>, now against your own, empty database under `data/`.

**Check it.**

```bash
curl -s localhost:3000/setup | jq
```

Right now it should report `worker_runner=mock` and `admin_auth` ok. The mock runner dispatches nothing, which is why this step needs no accounts.

## 2. Set up a sandbox provider

Every agent runs in a VM from the provider selected by `worker.runner`; the mock runner is for looking, not for working. Choose Tenki or Freestyle, create its API key and install its CLI. Step 4 uses the same provider to prepare a worker image.

### Tenki

| Variable | What to put in it |
|---|---|
| `TENKI_API_KEY` | Your API key. |
| `TENKI_PROJECT_ID` | Required when your account reaches more than one project. With exactly one, the runner selects it on its own. |

**Check it.** With the variables exported, the CLI answers for the key:

```bash
set -a; . ./.env; set +a
tenki status
```

### Freestyle

Create a permanent API key in the [Freestyle dashboard](https://dash.freestyle.sh), then install the CLI that is already pinned as Jardinero's `freestyle` dependency.

| Variable | What to put in it |
|---|---|
| `FREESTYLE_API_KEY` | Your permanent API key. |

**Check it.** With the variable exported, the CLI lists the VMs the key can reach:

```bash
set -a; . ./.env; set +a
pnpm exec freestyle vm list
```

## 3. Install Codex

Codex is the model that writes the code. Nothing installs it for you:

```bash
npm install -g @openai/codex   # or, on macOS: brew install --cask codex
codex login
```

That login is what the default mode uses. Pick one of three, in `worker.codex_auth_mode`:

| Mode | What it needs |
|---|---|
| `capsule` (default) | `codex login` once on this host. The runner forwards `~/.codex/auth.json` into each sandbox. No API key. |
| `access_token` | `CODEX_ACCESS_TOKEN`, for non-interactive automation. |
| `api_key` | `OPENAI_API_KEY`, to bill through the OpenAI Platform instead of a ChatGPT subscription. |

On `capsule`, read [Keeping capsule auth alive](secrets.md#keeping-capsule-auth-alive) now rather than later. That login goes stale on its own, and the symptoms do not say so.

**Check it.** On `capsule`, `codex login status` says which account it is using.

## 4. Build your worker image

Build one worker image per repository: the sandbox the agent works inside, carrying **that repository's** toolchain. There is no image to borrow, and one that lacks it fails after the agent has already done the work and paid for it.

Recipes live in [`../tenki-images/`](../tenki-images/), with three worked examples: `node-repo-example`, `go-repo-example` and `python-repo-example`. Despite the directory name, the setup recipes themselves are ordinary Linux scripts and can also prepare a Freestyle snapshot.

### Building it on Tenki

1. Copy the example closest to your stack to `tenki-images/recipes/<name>.sh`, and pin every version to your repository's own sources (Dockerfile, Makefile, CI) so the sandbox cannot drift from what your CI runs.
2. Copy its `.env` and set `IMAGE_NAME` and `REPO_SLUG=<owner>/<repo>`. Raise `SANDBOX_CPU` and `SANDBOX_MEMORY_MB` if your gate is heavy; a suite that exhausts the box wedges the sandbox.
3. Copy its `.verify.sh` and replace the body with your repository's own gate. This is the canary: it runs in a fresh sandbox spawned from the new snapshot, with your repository cloned, and nothing is published if it fails.
4. Build and publish it into your own Tenki workspace:

   ```bash
   make tenki-image REPO=<name>
   ```

   A private repository needs `GH_TOKEN` or a logged-in `gh` for the canary clone.

5. Put the ref it prints in your config:

   ```yaml
   worker:
     default:
       image: "<workspace-slug>/<image>:<tag>"
   ```

   `worker.default.image` is what a repository with no image of its own runs. To give one its own image, add it under `worker.repos` instead.

[`../tenki-images/README.md`](../tenki-images/README.md) has the rest of the flags.

**Check it.** This is the step worth verifying properly, because it exercises everything from steps 2 to 4 at once:

```bash
pnpm run smoke:tenki
```

### Building it on Freestyle

Choose the recipe exactly as above, then render its shared base plus repository toolchain into one setup script. `--no-verify` prevents the Tenki build driver's canary body from being appended; you will verify the resulting snapshot on Freestyle instead.

```bash
tenki-images/build.sh <name> --dry-run --no-verify > /tmp/jardinero-worker-setup.sh
vm_id="$(pnpm exec freestyle vm create --snapshot-id freestyle/ubuntu --slug jardinero-image-build --internet --output json | jq -r .id)"
pnpm exec freestyle vm fs write "$vm_id" /root/jardinero-worker-setup.sh /tmp/jardinero-worker-setup.sh
pnpm exec freestyle vm ssh "$vm_id" --exec "bash /root/jardinero-worker-setup.sh"
pnpm exec freestyle vm snapshot create "$vm_id" --slug <snapshot-slug> --output json
pnpm exec freestyle vm delete "$vm_id"
```

The snapshot must contain `git`, `gh`, Node 24, Codex, `sudo`, systemd and the repository toolchain. The runner creates the `tenki` user, injects the run credentials, and grows CPU or memory when the configured floor exceeds the snapshot's current size. Freestyle resources are grow-only, so choose `freestyle/ubuntu-sm` as the build base if log-review runs must stay at their 2 vCPU and 4 GiB shape.

Put the snapshot id or slug in the same image field:

```yaml
worker:
  runner: "freestyle"
  default:
    image: "<snapshot-slug>"
```

**Check it.** Boot a clean VM from the snapshot and run the recipe's `*.verify.sh` from a fresh clone, then delete the canary VM. With Jardinero running, `/setup` must report `freestyle_sdk`, `freestyle_auth` and `codex_auth` as `ok` before the first paid run.

It creates a real sandbox on your image, writes and reads a file, runs a command, forwards your Codex auth and asks the model for a short answer. If that passes, the expensive half of the setup is done.

## 5. Put it behind a public URL

GitHub and Linear deliver events over webhooks, so they have to reach you. On a laptop, any tunnel does. In a deployment, it is the ingress you already have.

You will paste that URL into the GitHub App in the next step; nothing about it is configured inside Jardinero. `server.public_url` is unrelated: it is only used to build dashboard links inside Discord messages.

**Check it.** From anywhere, the tunnel has to reach the running process:

```bash
curl -s https://<your-public-host>/health
```

## 6. Create a GitHub App

Yours, not ours. It is how Jardinero reads your repositories, pushes branches and opens pull requests, and it is the last mandatory step.

### Creating and installing it

1. [GitHub → Settings → Developer settings → GitHub Apps](https://github.com/settings/apps) → **New GitHub App**. Create it under the account that owns your repositories. Name it whatever you like, e.g. `<your-org>-jardinero`; names are unique across GitHub. That name is the handle you mention on pull requests, and the identity its commits carry.
2. **Homepage URL** is required and never checked; add any URL like `https://github.com/LuxorLabs/jardinero`.
3. **Webhook URL**: `https://<your-public-host>/webhooks/github`. **Webhook secret**: a random string; the same one goes in `JARDINERO_AGENT_WEBHOOK_SECRET`.
4. **Permissions**, exactly these six:

   | Permission | Access | Why |
   |---|---|---|
   | Checks | Read-only | Receive `check_suite`, so a red build wakes the maintainer. |
   | Contents | Read and write | Clone the repository and push the agent's branch. |
   | Deployments | Read-only | Receive `deployment_status`, which starts a log-review scan. |
   | Issues | Read and write | Issue comments and the reactions that show a comment was picked up. |
   | Metadata | Read-only | Mandatory, granted automatically. |
   | Pull requests | Read and write | Open them, comment, mark ready for review. |

5. **Subscribe to exactly these six events**: `Check suite`, `Deployment status`, `Issue comment`, `Pull request`, `Pull request review`, `Pull request review comment`. This is the trap of the whole setup: an event the App is not subscribed to simply never arrives, and nothing anywhere reports it.
6. Choose **Only on this account** to keep it on your own repositories, or **Any account** to let other people install it too, and press **Create GitHub App**.
7. **Generate a private key** and download the PEM. You get one chance.
8. **Install the App** on the repositories you want Jardinero to work on. Press **Install App** in its sidebar, pick the account that owns them, and choose **All repositories** or **Only select repositories**. It can push branches and open pull requests in every one it reaches. It leaves you on a URL ending in a number, `.../settings/installations/<id>`: that number is the installation id.

### What goes in .env

| Variable | What to put in it |
|---|---|
| `JARDINERO_AGENT_APP_ID` | The App id, on its settings page. |
| `JARDINERO_AGENT_INSTALL_ID` | The installation id, the trailing number of the installation settings URL. |
| `JARDINERO_AGENT_PRIVATE_KEY` | The PEM contents. |
| `JARDINERO_AGENT_WEBHOOK_SECRET` | The same secret you set on the webhook. |

Also set the identity the agent's commits are attributed to, so they link to the App rather than to the sandbox default:

```yaml
worker:
  git_author_name: "<name>[bot]"
  git_author_email: "<id>+<name>[bot]@users.noreply.github.com"
```

And tell it which handle to answer to, or a mention reaches Jardinero and it ignores you:

```yaml
workflows:
  pr_maintainer:
    agent_login: "<name>"
```

`<name>` is the App's name from step 1, in all three. `<id>` is the id of the bot user GitHub created with it:

```bash
gh api '/users/<name>%5Bbot%5D' --jq .id
```

Now switch the runner on, which is what makes runs real. Use the provider chosen in step 2:

```yaml
worker:
  runner: "freestyle" # or "tenki"
```

Boot refuses this with no `worker.default.image` from step 4, and with no App credentials above.

**There is no list of repositories to maintain.** A repository becomes one Jardinero works in the first time a webhook mentions it. Installing the App is the whole of it.

**Check it.** Open a pull request in a repository the App is installed on and mention the App in a comment. It reacts to the comment, and the dashboard shows a PrMaintainer instance moving. That is the end of the mandatory path.

## 7. Connect Linear, optional

This is what turns a ticket into a pull request.

### Creating the OAuth app

1. Linear → **Settings → API → OAuth applications** → create one.
2. **Ask Linear to enable the `client_credentials` grant on it.** It is not self-service, and nothing works without it. Do this first, because the wait is the long pole of this step.
3. Add a webhook pointing at `https://<your-public-host>/webhooks/linear`, and keep its signing secret.

### What goes in .env

| Variable | What to put in it |
|---|---|
| `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` | The OAuth app's credentials. Jardinero mints the app-actor token from them and re-mints it on a timer. |
| `LINEAR_WEBHOOK_SECRET` | The webhook signing secret. |

Then say which repository a team's tickets are implemented in. Boot refuses an enabled Linear with no mapping:

```yaml
workflows:
  linear_implementer:
    enabled: true
    team_repos:
      ENG: "your-org/your-repo"
```

A team that spans repositories gets a `default` plus `projects` and `repos`; see [`configuration.md`](configuration.md#linear-routing).

**Check it.** Assign a ticket to the agent in Linear. A LinearImplementer instance opens, and it iterates until its own verifier accepts the work.

## 8. Connect Discord, optional

This is what lets you drive it from chat, and tells you where the work went.

### Creating the app

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**, then add a bot to it.
2. Set the **Interactions Endpoint URL** to `https://<your-public-host>/webhooks/discord`. Discord verifies it on save, so Jardinero has to be reachable and running at that moment.
3. Invite the bot to your guild with permission to read and send messages and to create threads.

### What goes in .env

| Variable | What to put in it |
|---|---|
| `DISCORD_APPLICATION_ID` | The application id. |
| `DISCORD_PUBLIC_KEY` | Its Ed25519 public key. Interaction signatures verify against it. |
| `DISCORD_BOT_TOKEN` | The bot token. |
| `DISCORD_GUILD_ID` | Only read by the registration command below, when `--guild` is not passed. |

Turn it on, and say which channel belongs to which repository:

```yaml
discord:
  enabled: true
  default_channel_id: "<channel id>"
  repo_channels:
    your-org/your-repo: "<channel id>"
```

The commands do not exist in a guild until they are published:

```bash
pnpm run discord:register --guild <guild id>
```

**Check it.** `/jardinero-status` answers in the channel. Then `/jardinero-code` asks for work in your own words, and `/jardinero-ticket` implements one that already exists.

## 9. Turn on log review, optional

This is what reads your production logs on a schedule and opens a fix for what it is confident about. This one has a hard prerequisite: **it is Grafana plus Loki plus Kubernetes**, and there is no adapter for another telemetry stack.

1. Expose Grafana's remote MCP server so the host can reach it.
2. Create a Grafana service account token and put it in `GRAFANA_SA_TOKEN`.
3. Turn it on and describe your fleet. The `services` have to match your Loki labels, and the repository named in each entry is where the fix is opened:

```yaml
mcp:
  grafana:
    enabled: true
    url: "https://<your-grafana-mcp-host>/mcp"

workflows:
  log_reviewer:
    enabled: true
    repos:
      - repo: "your-org/your-repo"
        namespace: "production"
        clusters: ["your-cluster"]
        services: ["api", "worker"]
```

That service-to-repository mapping is manual on purpose: it is the only way Jardinero can know where the code behind a log line lives.

**Check it.** Do not wait for the cron:

```bash
curl -H "Authorization: Bearer $ORCHESTRATOR_ADMIN_TOKEN" \
  -X POST 'http://localhost:3000/admin/trigger/log-review?repo=your-org/your-repo'
```

## Running it in production

Jardinero is a Node process holding SQLite under `data/`. It needs that directory on a disk that survives a restart, and it needs to stay up, because the workflows that poll and scan run on its own clock.

Run the published image rather than building it:

```bash
docker run -d --name jardinero \
  -p 3000:3000 \
  --env-file .env \
  -v jardinero-data:/app/data \
  -v "$PWD/config.yaml:/etc/jardinero/config.yaml:ro" \
  -e CONFIG_PATH=/etc/jardinero/config.yaml \
  ghcr.io/luxorlabs/jardinero:latest
```

Mount your own configuration rather than editing `config/local.yaml` in a checkout. That file is the whole configuration: there is no merge across files, and every key it omits takes its code default.

Three things will bite you, and none of them are configuration:

- **Never run two.** State is SQLite on one volume, which tolerates one writer. A second instance against it corrupts the database rather than sharing the load.
- **The volume holds the backups too.** The hourly backups sit beside the database, so they survive a corrupted file and not a lost disk.
- **Put authentication in front.** Jardinero has no login; it reads the identity a proxy sets on the request. And keep `ORCHESTRATOR_ADMIN_TOKEN` set, because `/capsule/sql` runs read-only SQL over the whole database.

For a cluster, [`../examples/deploy/`](../examples/deploy/) has a kustomize base with the Deployment, Service, Ingress and PVC already carrying all three, plus a compose file for one box.

## When something does not work

Ask preflight first. It answers for every credential in every step above:

```bash
curl -s localhost:3000/setup | jq
```

Two failures it cannot see, both from step 6: an event the App was never subscribed to, and a permission it was never granted. Both are silent. If the dashboard stays empty while GitHub says the webhook delivered, that is where to look.
