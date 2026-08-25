# Security policy

## Reporting a vulnerability

**Do not report security vulnerabilities through public issues, discussions or pull requests.** A public report tells an attacker about the hole before a fix exists, and every other installation is what pays for the gap.

Use [GitHub's private vulnerability reporting](https://github.com/LuxorLabs/jardinero/security/advisories/new) instead. It opens a private thread with the maintainers on this repository.

Tell us what you found, how to reproduce it, and what an attacker gets out of it.

There is no guaranteed response and no timeline; Jardinero is published as it is. If we do act on a report, we will say so and coordinate the disclosure with you.

Send it privately regardless of whether we answer.

## What is in scope

This repository: the orchestrator, its HTTP surfaces, the prompts and the sandbox recipes.

Two things are out of scope because they are not ours to fix, though we would still like to hear about them: the services Jardinero integrates with (GitHub, Linear, Discord, Grafana, Tenki, OpenAI), and the agent's own output. An agent writing bad code is a quality problem, not a vulnerability; an agent that can be made to exfiltrate a credential is a vulnerability, and we want that one.

## What deserves a report

Jardinero holds credentials for every service it touches and runs model-authored code in sandboxes, so the interesting failures are usually about the boundary between those:

- A credential reaching somewhere it should not: a log line, an artifact, a prompt, a pull request body, a sandbox that should not have received it.
- A way to reach `/admin/*` or `/capsule/*` without the bearer token. `/capsule/sql` runs read-only SQL over the whole database.
- A webhook accepted without a valid signature, or a signature check that can be bypassed.
- Anything that makes the agent act on a repository nobody authorized it to touch.

## Supported versions

There are no long-term support branches. Whatever gets fixed goes out in the next release, and nothing is backported.

## Running it safely

Jardinero has no login of its own: it reads the identity an authenticating proxy sets on the request. An instance exposed to the internet without one in front is operable by anyone who reaches it, and that is not a vulnerability in Jardinero. See [`examples/deploy/README.md`](examples/deploy/README.md).
