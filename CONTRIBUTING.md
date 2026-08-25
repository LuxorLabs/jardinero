# Contributing

## Getting it running

[`docs/setup.md`](docs/setup.md) goes from a fresh clone to an agent opening a pull request. You do not need any of it to change code: `make install` and `make preview` serve the dashboard on invented data with no accounts at all.

```bash
make install
make dev       # hot reload on http://localhost:3000
make check     # the gate CI runs: types, format, lint, web build, tests, changeset
```

Node 24 and pnpm. With nvm, `nvm use` picks the right Node; `corepack enable pnpm` gets the pinned pnpm.

## Before you open a pull request

`make check` has to pass. It is exactly what CI runs, so a green local run is a green pull request.

Add a changeset for anything a user would notice:

```bash
pnpm changeset
```

One line describing the change from the outside. Releases are cut from these, and the check refuses a pull request without one unless the change is invisible.

## How this repository is written

[`AGENTS.md`](AGENTS.md) is the whole of it: the shape every state machine has to keep, what a test owes, where a case goes, how comments and commits are written. It is not a style guide nobody reads. Two things in it are worth knowing before your first pull request, because they are what a review will send back:

**Every branch you add is covered in the same pull request.** One case per decision point, as a row of that function's table, in the order the branches appear. A pull request that adds a branch and no case is incomplete.

**The five workflows are one design written five times.** Reading one has to teach you the other four, so a change to the shape of one is a change to all five, never a local convenience.

## Reporting things

A bug, a question or an idea: open an issue. Know what it can expect first: Jardinero is published as it is, nobody here is on call for it, and an issue may sit. One that comes with a reproduction, or with a pull request, is the one most likely to move.

A vulnerability: do not open an issue, because a public one tells an attacker before a fix exists. [`SECURITY.md`](SECURITY.md) is the private door.
