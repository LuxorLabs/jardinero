<img src="assets/banner.png" alt="Jardinero — tends your codebase while you're away" />

# Jardinero: the always-on AI engineer for your repositories

It watches your production logs, implements the tickets you hand it, and keeps your pull requests moving. Every piece of work runs in a throwaway sandbox that you host yourself, and every result comes back as a pull request a person reviews.

## One gardener, three jobs

**It watches your logs.** On a schedule, Jardinero reads your service telemetry through Grafana, decides which errors are real, and opens a fix for the ones it is confident about.

**It implements your tickets.** Assign a Linear ticket to Jardinero and it scopes the work, writes it in an isolated sandbox, runs your test suite, and hands back a pull request. It iterates until its own verifier accepts the result.

**It keeps pull requests moving.** Tag it on a pull request and it answers review threads, fixes failing checks and follows the conventions already in your repo.

You reach it from Discord, from Linear, from GitHub, or from its own dashboard.

## See it running

A local demo on mock data. No accounts, and it touches nothing:

```bash
make install
make preview
```

That serves the dashboard alone on <http://127.0.0.1:4178/dashboard>, against a throwaway database of invented work, so every tab has something in it. Nothing runs behind it: no agents, no sandboxes, no repository touched.

Needs Node 24 and pnpm. With nvm, `nvm use` picks the right Node; `corepack enable pnpm` gets the pinned pnpm.

## What you need

Jardinero orchestrates agents; it does not run them itself. This is what you have to have; [`docs/setup.md`](docs/setup.md) is how to get it.

| | |
|---|---|
| A host that stays up | Node 24, ~1 GB RAM, a persistent disk for the SQLite database. A laptop with a tunnel is fine to try it. |
| A public HTTPS URL | GitHub and Linear deliver over webhooks. Without it nothing reaches Jardinero. |
| A [Tenki](https://tenki.cloud) account | Every agent runs in a Tenki sandbox. This is the meter that runs. |
| A GitHub App you create | Installed on the repositories you want Jardinero to work on. Every workflow ends in a pull request. |
| Codex auth | A ChatGPT/Codex login, or an OpenAI API key. |
| Something to run `pnpm run codex:refresh` on a timer | Only on a ChatGPT/Codex login. Left alone it goes stale and every run starts failing. [`docs/secrets.md`](docs/secrets.md) explains why. |
| One worker image per repository | Built in your own Tenki account, carrying that repository's toolchain. A repository whose image lacks it fails after the agent has already done the work. |

**To keep pull requests moving:** nothing else. It is on by default; tag the App on a pull request and it starts.

**To implement tickets:** a Linear workspace, an OAuth app with the `client_credentials` grant, and a mapping from each Linear team to the repository its tickets belong in. Linear enables that grant on request; it is not self-service.

**To review logs:** Grafana with its remote MCP server reachable, a service account token to query it with, Loki behind it, and the list of services each repository owns. This workflow assumes Kubernetes and reads Loki labels for cluster, namespace and service; there is no adapter for another telemetry stack.

**To drive it from chat:** a Discord application, and a guild to publish its commands in.

Every pass costs money: sandbox time in Tenki, plus the Codex tokens the agent spends. There is no free tier. Jardinero records what each run cost when Codex reports it, and the dashboard adds it up.

## Setting it up

[`docs/setup.md`](docs/setup.md) walks the whole thing: the Tenki account and the worker image, the GitHub App and its webhook, Codex auth, and then whatever you want on top of it. Configuration lives in `config/local.yaml` and is documented in [`docs/configuration.md`](docs/configuration.md); credentials come from the environment, never from the config, and each one is listed in [`docs/secrets.md`](docs/secrets.md).

Two ways to run it for real, both worked examples in [`examples/deploy/`](examples/deploy/): a Compose file for one box, and a kustomize base for a Kubernetes cluster.

At any point, ask what is still missing:

```bash
curl -s localhost:3000/setup | jq
```

## How it works

Every piece of work is an instance of one of five workflows, each a state machine: **RequestRouter**, **LinearImplementer**, **FixImplementer**, **PrMaintainer** and **LogReviewer**. State lives in SQLite. Nothing decides what happens next except the state machine that owns the work.

- [`docs/setup.md`](docs/setup.md) — from a fresh clone to an agent opening a pull request.
- [`docs/architecture.md`](docs/architecture.md) — the components, the boot order, how work flows, the tables.
- [`docs/workflow-engine/README.md`](docs/workflow-engine/README.md) — the five workflows and the end-to-end flows, with diagrams.
- [`docs/dashboard.md`](docs/dashboard.md) — the operator dashboard.
- [`docs/configuration.md`](docs/configuration.md) — every configuration knob.

## Development

Requires Node 24 (`.nvmrc`) and pnpm. `make help` lists every target.

```bash
make dev       # hot reload
make check     # the full gate CI runs: types, format, lint, web build, tests
```

Conventions for anyone editing this repository, human or agent, are in [`AGENTS.md`](AGENTS.md).

## Contributing

Found a bug 🐛, or a job Jardinero should be doing while you are away ✨? The [contributing guide](CONTRIBUTING.md) has the setup, and how we like things written.

Found a security problem? Please do not open an issue: a public one hands an attacker the hole before a fix exists. [`SECURITY.md`](SECURITY.md) is the private door.

### The people who built it

<a href="https://github.com/LuxorLabs/jardinero/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=LuxorLabs/jardinero" alt="Contributors" />
</a>

## License

MIT. See [`LICENSE`](LICENSE).
