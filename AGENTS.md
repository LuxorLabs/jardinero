# AGENTS.md

Conventions for whoever edits this repository, human or agent. Codex reads `AGENTS.md` by name, and [`CLAUDE.md`](CLAUDE.md) is a one-line import of this file so Claude Code reads the same thing. "Agent" here means the coding agent editing the repo, not the agents Jardinero runs; those are defined below.

## What Jardinero is

A TypeScript/Node control plane for autonomous engineering agents. Every piece of work is an instance of one of five workflows, tracked in SQLite and executed in an ephemeral Tenki sandbox that runs Codex; Jardinero verifies what the agent produced and shows an operator what happened.

The two words are not interchangeable: a **workflow** is one of the five state machines (`request_router`, `linear_implementer`, `fix_implementer`, `pr_maintainer`, `log_reviewer`) and the instance it advances; an **agent** is a seat that runs inside a sandbox (`sandbox_run.agent_name`, and the prompt it is given), and one workflow may dispatch several.

Read [`docs/architecture.md`](docs/architecture.md) first for the components, the boot order and how work flows, then [`docs/workflow-engine/README.md`](docs/workflow-engine/README.md) for the workflows themselves. Setting it up from nothing: [`docs/setup.md`](docs/setup.md). Subsystem docs: [`docs/dashboard.md`](docs/dashboard.md), [`docs/secrets.md`](docs/secrets.md), [`tenki-images/README.md`](tenki-images/README.md).

## Repository layout

| Path | Responsibility |
|------|----------------|
| `src/index.ts` | Bootstrap; constructs and wires every subsystem |
| `src/config.ts` + `config/local.yaml` | Config tree, loaded and validated at boot |
| `src/transport/*` | Every HTTP surface: `server.ts` routes to `dashboard/`, `admin/`, `capsule/`, `webhooks/` and `health/` |
| `src/store/*` + `db/schema.sql` | SQLite state, event log, per-run artifacts |
| `src/orchestrator/state-machines/*` | One directory per workflow: the state machine that owns it, and the only place that decides what happens next |
| `src/orchestrator/*` | `engine-commands.ts` (the seam transport uses), `sandbox-pool.ts` (caps, kill, run lifecycle), `scheduler.ts` (cron and polling), and the `WorkerRunner` boundary in `worker/` |
| `src/workflows/*` | Per-workflow prompts, payloads and result parsers, one directory each: `linear/`, `pr/`, `log-review/`, `router/` |
| `src/adapters/*` | One directory per outside service: `github/`, `linear/`, `tenki/`, `codex/`, `grafana/` |
| `src/platform/*` | Cross-cutting primitives with no domain knowledge: logger, time, ids, json, url parsing, locks, preflight |
| `web/` | Operator dashboard SPA (React + TypeScript, Vite, Tailwind, shadcn/ui) |
| `scripts/` | One-shot CLIs: `smoke:tenki`, `ui:preview`, `discord:register`, `codex:refresh` |
| `src/**/*.test.ts` | Unit tests, co-located with the module they cover |
| `src/testing/` | Shared test harnesses; never imported by production code |
| `test/functional/api/` | Suites that enter through HTTP, by subject |
| `test/functional/ui/` | Suites that assert an invariant of the `web/` sources the API cannot answer for |

## The shape of a state machine

The five machines are one design written five times, copied from the MCA acquiring FSM. It is not a style: reading one machine has to teach you the other four, so the shape below is fixed. Changing it is a change to all five at once, never a local convenience, and a PR that bends it in one machine is wrong however well the feature works.

The four files each machine is made of are listed in [`docs/workflow-engine/README.md`](docs/workflow-engine/README.md); what follows is what the code inside them has to look like.

**Every `on<Event>` returns `Promise<Error | undefined>`.** An entry point that has something else to tell its caller does not get a new return type; it gets a port to say it on, the way `markReadyForReview` and `markCommentPickedUp` are said. Wrapping the return in an outcome object breaks the one contract every transport, adapter and test relies on.

**Every `case` is one of four shapes**, and the last line of the branch is what makes it visible at a glance:

| Shape | Last line |
|-------|-----------|
| The empty cell: the event changes nothing here | `return undefined` |
| Change state and stop | `return setState(engine, instance, '<state>')` |
| Change state and run the machine | `return setStateAndRun(engine, instance, '<state>')` |
| Run the machine without changing state | `return run<Workflow>FSM(engine, instance)` |

A branch may do work before that line: consume the ask, clear `needsHumanReason`, abort a run, write on GitHub through a port. It may not end in anything else. One that grows too long to read gets a named `process<X>` helper that itself ends in one of the four.

`default` returns `new UnsupportedStateError(instance.workflowState)`. An unknown state is refused, never folded into the endings and never guessed. Terminal states are written out in every switch: no shared "has it finished" helper, no arrays of states, no `.includes()`. The duplication between events is deliberate, and it is what keeps the state × event matrix readable in the code.

## Development commands

Requires Node >= 24 (`.nvmrc`, `engines`) and pnpm. Run `nvm use` first, then `corepack enable pnpm`. `make help` lists every target.

```bash
make install        # pnpm ci from the lockfile
make dev            # hot reload on 0.0.0.0:3000 (tsx watch)
make build          # build server (dist/src) + dashboard SPA (dist/public)
make check          # FULL pre-PR gate: type-check, format check, lint, web build, tests, changeset
```

`make check` is exactly what CI runs. Run it before opening a PR. Its parts:

```bash
make type-check     # tsc --noEmit for server (tsconfig.json) AND web (web/tsconfig.json)
make check-format   # biome format check (fails if unformatted)
make lint           # biome lint
make build-web      # vite build; REQUIRED before tests, which assert on the built bundle
make test           # pnpm test: build:test, then node --test on dist/src/**/*.test.js + dist/test/**/*.test.js
make check-changeset # fail if no changeset or it is not a single line; skip with CHECK_CHANGESET=false
```

For dashboard work with hot reload, run `pnpm run dev` (API) and `pnpm run dev:web` (Vite) side by side; the Vite dev server proxies `/dashboard/api` to `:3000`.

Tool versions are pinned so nothing depends on a dev's global environment: the Node major via `.nvmrc` + `engines`, the pnpm version via `packageManager`, exact dependency versions in `package.json` (no `^`/`~`), and deterministic installs from `pnpm-lock.yaml` via `pnpm ci`. Keep it that way when adding dependencies.

A dependency's install scripts do not run unless it is listed in `allowBuilds` in `pnpm-workspace.yaml`. Adding a dependency that needs one is a deliberate entry there, not a default.

### Docker

```bash
make up / make down / make logs   # local dev stack (hot reload, persistent SQLite)
make docker-build / make docker-run   # production image (Dockerfile.prod)
```

## Test conventions

**Runner**: Node's native `node:test` (`import { describe, test } from 'node:test'`, `import assert from 'node:assert/strict'`). No third-party test framework. Tests run against compiled output, so `pnpm test` builds first.

### What every PR owes

Not optional, and not a later ticket:

- **Every branch you add or change is covered in the same PR**, cyclomatically: one case per decision point, as a table row, in the order the branches appear in the function, read top to bottom. A PR that adds a branch and no case is incomplete.
- **Every endpoint, webhook or page you add gets a functional test** in `test/functional/`, at least one case, in the suite named for its subject.
- **Every source file you add gets its adjacent `<module>.test.ts`**, unless it is types only or wiring with no decisions of its own.
- **Every test file you touch leaves following these rules**, whatever shape you found it in. Fixing the file you are already editing is not scope creep.

### The short list

Once the above applies, follow this order. Everything below only explains why.

1. **Export inventory**: the module's exported functions, in source order. One `describe` each, in that order.
2. **Branch inventory**: read each function top to bottom and record every decision point. This is the artifact to review; the tests transcribe it.
3. **One case per branch**, in inventory order, so reading the test mirrors reading the function.
4. **Rows that share the act and the assertion go in a table**; a case that asserts different state gets its own `test()`. An `if` inside the loop choosing *how* to assert means two shapes were crammed into one table: split it.
5. **One table per function**, holding its whole branch inventory. A case that looks like an outlier usually is not: widen what the row asserts, the whole returned object instead of one of its fields, and the accepted path and every refusal become rows of the same table.
6. **A `describe` never mixes loose tests in with a table.** What the table genuinely cannot assert moves to its own `describe`, named after the behavior, never to a loose `test()` beside the table. A behavior several functions share gets that same treatment.
7. **Suites first, plumbing last.**
8. **Name each case** `When <condition> then should <outcome>`, literals in backticks.
9. **Verify** with the coverage gate for that module, then reclaim the indirect coverage the functional tier was paying for that logic.
10. **Do not chase 100%.** If a case needs a refactor, a live service or the host machine, drop it and say so. Uncovered code is a missing case or code unreachable from the public API; never annotate it to look covered.

### Where a case goes

Adding a `test()` is the last thing to reach for, not the first. Whatever you wrote or changed, ask in this order:

1. **Is it a case of a table that already exists?** Then it is a row, wherever that table lives.
2. **Did the change add a branch?** Then it is a row of that function's table, in the order the branch appears in the function.
3. **Did the change alter what an existing case produces?** Then the assertion of the rows widens; a new case that only re-acts what a row already acts is a duplicate.
4. **Is it a new exported function?** Then it gets its own `describe` with its own table.
5. **Only if a table genuinely cannot hold it**, a plain `test()`, in a `describe` named after the behavior it groups. Never loose beside a table.

Never: a `skip` standing in for a missing test, a fixed `setTimeout` where polling with `eventually` works, a fake whose signature is looser than the real collaborator's, or a second `describe` suffixed onto a function that already has one.

Coverage gate: `node --test --experimental-test-coverage --test-coverage-include='dist/src/<module>.js' dist/src/<module>.test.js`.

### Tiers

Two tiers, both required, with the obligation scoped per tier. Unit tests are white box; functional tests are black box, entering through a public entry point and knowing nothing about the internals.

| Tier | Lives in | Proves | Obligation |
|------|----------|--------|------------|
| Unit | `src/**/<module>.test.ts`, beside the module | Every exported function, on every path | **Per function**: one case per branch of the function you are covering |
| Functional | `test/functional/` | Behavior through a real boundary, whatever the internals | **Per entry point**: at least one case per endpoint, webhook or page |

A functional suite may build a real `Store` and `Orchestrator` because the boundary needs them to answer; that is scaffolding, not a reason to call it something else. Sub-foldering is by **how the test enters**: `api/` through HTTP, `ui/` over the `web/` sources. A suite that constructs an entry point and never calls it is misfiled: an HTTP suite whose body has no `fetch` is a unit test wearing a server boot.

**Entering through an import is the unit tier**, however many real collaborators sit behind the call. Fidelity and tier are different axes: a test that drives `LinearImplementerStateEngine.onIssueAssigned()` against a real pool, a real worker and a real SQLite file is still a test of one module, and lives beside it. Only HTTP is a boundary a test can cross from outside.

**There is no integration tier, on purpose.** Integration means two live systems playing together, and everything here runs in one process. The word is reserved for when we test against a real Tenki, a real Linear or GitHub, or two Jardinero processes; inventing it now for module boundaries would make the label false.

**Coverage is claimed once.** When the unit tier owns a semantic, the tiers above prove only the delegation: that the param is read, that the shaped payload is passed through.

**Splitting a module for testability is a cost judgment, not a rule.** A single export is a legitimate design, and the functional tier genuinely covers what sits behind it. Split when covering a module's branches through its only entry point costs more than the module itself, or leaves branches unreachable; below that threshold, one export is fine and the functional tier owns it.

Moving or regrouping a test file is mechanical, and a codemod is fine for it. The branch inventory never is: a codemod reorders what exists and by definition cannot add the branch nobody wrote.

### Where a file goes

- **Unit**: one per source file, beside it, and only it. No adjacent file means the module is untested at this tier; a wiring module with no decisions of its own is the only legitimate case. Shard a multi-area source as `<basename>.<area>.test.ts` (`store.pr-maintainer.test.ts`); a function serving two areas gets a suite in each shard for the behavior that shard owns. Test only what the file owns: a re-exported helper is covered where it is defined.
- **Functional**: named for their **subject**, never for the feature or PR that created them. `test/functional/api/webhooks.test.ts`, not `linear-http.test.ts`. A file named after its origin becomes the dumping ground for everything that follows.
- **Shared harnesses** live in `src/testing/`: `http.ts` for the API fixture, `store.ts` for the DB, `state-machines.ts` for a wired engine. They and every `*.test.ts` are excluded from the production build by `tsconfig.build.json`. Copying a fixture instead of importing one is how 700-line preambles get duplicated.

### What a file looks like

- Order is imports, shared constants, the `describe` blocks, then fixtures, builders and case types. Function declarations hoist, so a table can call `task()` before it is defined.
- A `describe` is named after what it groups: the function at the unit tier (`Store.openPrMaintainer`), the endpoint at the functional tier (`GET /dashboard/api/pull-requests`), the behavior when the group crosses functions (`Store reads for unknown ids`). **A function gets one describe, not one per batch of work**: the rejection cases of `openPrMaintainer` go inside `Store.openPrMaintainer`, never in a second `Store.openPrMaintainer rejections` beside it, which is how a suite turns into a changelog of who touched it.
- A table is a `cases` array plus a loop registering one `test()` per case. It is the tool for enumerating branches, not a style, and it always lives inside its `describe`, never loose at module scope. One function's branches belong to one table: a second table over the same act, or a loose `test()` beside the table, means the inventory was split in two.
- **The cost of a row must match the tier.** At the unit tier a row is free, so enumerate every branch. At the functional tier a row can cost a server boot, so either each row earns it or the cases collapse into one test with several assertions.
- Fixtures shared by every suite in the file go in one top-level `beforeEach`/`afterEach`; root hooks cascade into every `describe`.
- The two halves of a case name are the point: state the condition that triggers it and the outcome you can observe, never what the function does. `dedups concurrent triggers` describes the code; `When two triggers arrive for the same PR then should dedup and complete one run` is a test name. A bare `then should succeed` on an endpoint says nothing. Underscores appear only inside backticked literals, because unlike Go the node runner prints the name as written.
- **A fake must not be looser than the real collaborator.** Widening a return type to `unknown` so a stub can return whatever it likes is how a suite ends up asserting a payload the system never produces; type the seam to the real signature instead.

### Reference files

`src/workflows/side-effects.test.ts` is the reference for a unit file: a `describe` per exported function, a table per branch inventory. `test/functional/api/webhooks.test.ts` is the reference for a functional one: a `describe` per endpoint, contract-level names.

## Code quality rules

### Writing style
- Do not use " - " (space-dash-space) as a clause separator in prose. Use periods or commas.
- Write markdown prose one line per paragraph (and per list item); never hard-wrap at a fixed column. The render is identical, and it keeps edits and diffs sane.

### File handling
- ALWAYS end every file with a trailing newline (`.ts`, `.md`, `.yaml`, etc.).
- Do not create new files when editing an existing one will do. Only add docs when they add real value or are explicitly requested.

### Comments
Comment only where a comment is needed, and when you do, **say concisely why that block is there**. The subject is always the code directly below: not a consequence somewhere else in the system, not what would break without it, not how it came to be. Those are true things that belong in a PR description, and above a block of code they are noise.

A comment earns its place only if it does one of these:

- Explain WHY something is done a certain way: business logic, edge cases, workarounds.
- Document non-obvious behavior or a gotcha.
- Provide context the code cannot carry on its own.

Formatting:

- For extra clarification inside a comment, use a semicolon, not parentheses: `// ask about config; default no` not `// ask about config (default no)`. No semicolon when no clarification is needed.
- Function/doc comments are concise: 1-2 lines max, clarifying only what isn't obvious from the signature and names. No 5-6 line prose headers.

NEVER add comments that:

- Restate what the code already says (`// Get all users` above `getAllUsers()`).
- Explain changes between commits (that belongs in the PR description).
- Describe obvious operations (`// Loop through items` above a `for` loop).
- Narrate the change/PR instead of the code. A comment that only makes sense relative to an edit (`// now read pools before groups`, `// switched to X`) belongs in the PR description. Write for someone reading the code fresh in a year, not for the reviewer of this PR.

### Logging
- Logs must be actionable. If a log doesn't help identify or debug a specific problem, don't add it.
- Log specific failures with identifying fields (ids, keys, reason), not summary counters. For counts and aggregates use `event_log`, which the operator surfaces read; there are no Prometheus series of our own.
- Log through the scoped `logger` (`src/platform/logger.ts`) so output stays on the documented `HH:MM:SS.mmm LEVEL [scope] message key=value` format.

## Commit messages

Format: `scope: verb + short description`.

- `scope` is the subsystem touched, drawn from the repo's own areas: `dashboard`, `linear`, `config`, `agent`, `orchestrator`, `store`, `worker`, `scheduler`, `infra`. Use a short, focused scope, not a service name from another repo.
- Present-tense verb (`add`, `fix`, `update`, `implement`, `remove`), lowercase after the colon. Keep it a simple, short, single line; avoid a body.
- Do NOT put ticket IDs in commit messages; ticket IDs belong in PR titles only.

## Pull request descriptions

Keep the body short and readable, not a template.

- Open with one line: `This PR <verb> <what it fixes, adds, or does>` (`adds`, `fixes`, `makes`, `removes`, …).
- If you write more than one sentence, put each on its own line separated by a blank line; never hard-wrap.
- Add `## Why` / `## Changes` / `## Testing` sections only when they genuinely add value; do not scaffold them by reflex.
- Ticket IDs go in the PR title, not the body.

Example: `This PR adds a scheduled workflow that refreshes the Codex auth.json and writes it back to the secret store, so the token stops going stale.`

## Things that are easy to get wrong

- **Only a workflow's state machine decides what happens next.** An adapter or a helper that starts to branch on a workflow state is in the wrong place: that belongs in `state-handlers.ts`. An adapter that decides for itself what the machine would have accepted is the same mistake wearing a heuristic; when the outside world has to be told, the machine tells it through a port. See [The shape of a state machine](#the-shape-of-a-state-machine).
- **There is no queue.** A run the pool's caps refuse is refused, not queued; the instance stays in its `*_pending` state and the periodic check asks again. Don't add a queue to make it retry.
- **Recovery is durable and must stay that way.** Boot reconciles sandbox runs left `running` by a crashed process to `orphaned` (`Store.initializeAfterBoot`) and then walks every open instance (`recoverOpenInstancesAfterBoot`).
- **Unknown Codex cost is `NULL`, not `0`.** Don't treat a missing cost as free; cost-budget enforcement is intentionally skipped for that run.
- **Shared response types** between server and SPA live in `src/transport/dashboard/dashboard-api-types.ts`. Change both sides together.
- **Generated/built output** under `dist/` is never hand-edited.
- **Secrets** come from the environment / `.env` (never committed). See `docs/secrets.md`; key names are configured in the config, not hardcoded.

## Configuration

Runtime config is loaded from `CONFIG_PATH`, falling back to the in-repo `config/local.yaml`; the shape is validated by `src/config.ts`. The loaded file is the whole config — there is no merge across files, so whatever it sets (e.g. `workflows.linear_implementer.team_repos`) is the complete value, with per-key code defaults filling anything omitted.

Adding a config key: put its default in the `src/config.ts` reader — the code owns defaults, and config files carry only overrides, so never add a value equal to its default to `config/local.yaml` or the deploy config. Then add the key and its default to the defaults test, which `deepEqual`s the whole default tree, and cover parsing/validation with synthetic YAML via the `loadYamlConfig` helper rather than by asserting `config/local.yaml` values — the bundled config's own values are certified separately in `src/config.bundled.test.ts`.

`config/local.yaml` is the default for local dev and for ephemeral self-contained instances (e.g. a Jardinero spun up in Tenki to demo a PR); it is **not** authoritative for real deployments. In a real deployment the authoritative config lives wherever that deployment is defined, mounted into the container with `CONFIG_PATH` pointed at it, so a config change is a deploy edit plus a restart, not a code change or an image rebuild.

Secrets are read from the process env and, locally, from `.env` (template `.env.example`). Set `worker.runner: "mock"` for local smoke tests, `"tenki"` for real sandbox execution. See the README for the auth modes and the per-repo worker-image overrides.
