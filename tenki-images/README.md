# Worker images

Reproducible recipes for the Tenki sandbox images the agents run in. Each image bakes a common base (git, GitHub CLI, Node 24, Codex) plus one repository's dev toolchain, so a run can clone, build, lint, test and open a pull request in that repository.

A repository whose image lacks its toolchain fails late and expensively: the sandbox starts, the clone succeeds, the agent does the work, and the gate falls over on a compiler that is not there.

`default` is the exception to one image per repository. It belongs to no repository and carries the runtimes an un-onboarded one is most likely to need. `worker.default.image` points at it, so a repository with no entry in `worker.repos` runs that rather than borrowing another repository's toolchain.

The build runs **in Tenki**, not locally. `build.sh` only drives the `tenki` CLI: it creates a sandbox on the stock base, runs the composed setup inside it, snapshots the VM, and publishes the snapshot as a private registry image in your own workspace.

## Layout

```
tenki-images/
  build.sh              # orchestrator: create -> setup -> snapshot -> canary -> publish
  lib/base-setup.sh     # common to every worker (git, gh, Node 24, Codex)
  recipes/
    default.sh          # in-sandbox: the runtimes for a repository with no recipe of its own
    <repo>.sh           # in-sandbox: that repository's toolchain
    <repo>.env          # host-side: image name, repo slug, sandbox size (optional)
    <repo>.verify.sh    # canary: a build/test run that proves the image (optional)
```

Three worked examples ship here: `node-repo-example`, `go-repo-example` and `python-repo-example`. Copy the closest one and edit it.

This is step 4 of [`../docs/setup.md`](../docs/setup.md), which is where it sits in the order of everything else.

## Add your repository

1. Copy the example closest to your stack to `recipes/<name>.sh`, and pin every version to your repository's own sources (Dockerfile, Makefile, CI) so the sandbox cannot drift from what your CI uses.
2. Copy its `.env` and set `IMAGE_NAME` and `REPO_SLUG=<owner>/<repo>`. Raise `SANDBOX_CPU` and `SANDBOX_MEMORY_MB` if your gate is heavy; a suite that exhausts the box wedges the sandbox.
3. Copy its `.verify.sh` and replace the body with your repository's own gate.
4. Build it.

```bash
export TENKI_API_KEY=...
export TENKI_PROJECT_ID=...
# The workspace slug is derived from the authenticated session; set
# TENKI_WORKSPACE_SLUG only to override it.

make tenki-image REPO=<name>                        # bakes Codex @latest
make tenki-image REPO=<name> CODEX_VERSION=0.139.0  # pin the Codex CLI
```

On success it prints the published ref, which is what goes in `worker.repos.<owner>/<repo>.image`, or `worker.default.image` for anything with no entry of its own. See [`../docs/configuration.md`](../docs/configuration.md).

## Canary verification

If `recipes/<repo>.verify.sh` exists, `build.sh` spawns a sandbox from the fresh snapshot, clones `REPO_SLUG`, and runs that script with the working directory at the repository root before publishing. If it fails, nothing is published.

Verification runs in a sandbox spawned **from** the snapshot rather than in the one that built it, so the published image stays clean: no clone, no build artifacts baked in, yet proven to build the repository.

`default` has no repository to clone and therefore no canary. Nothing proves it beyond the versions its setup records.

Cloning a private repository needs `GH_TOKEN` or `GITHUB_TOKEN`, or a logged-in `gh`. Skip the canary with `--no-verify`.

## Other flags

`--dry-run` prints the composed setup script without touching Tenki:

```bash
tenki-images/build.sh <name> --dry-run
```

`--base-image <ref>` builds on top of an existing registry image rather than the stock Tenki base, so the new image inherits that base's kernel and clocksource. A recipe can set the same default with `BASE_IMAGE` in its `.env`, and the flag overrides it.
