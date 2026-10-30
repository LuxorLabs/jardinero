# jardinero

## [0.12.0] - 2026-10-29

### Minor Changes

- [#156](https://github.com/LuxorLabs/jardinero/pull/156) [`175f9e5`](https://github.com/LuxorLabs/jardinero/commit/175f9e5a8137bb5a223ee5cc3c138c1bd370b2e5) Thanks [@luciocorral](https://github.com/luciocorral)! - config: add `worker.prompt_overrides`, which turns off the guidance saved from the dashboard

- [#154](https://github.com/LuxorLabs/jardinero/pull/154) [`66f17e1`](https://github.com/LuxorLabs/jardinero/commit/66f17e11d92cb43efc597ca2b9c118df88883aa0) Thanks [@luciocorral](https://github.com/luciocorral)! - transport: remove the unused `/capsule/*` routes and answer `/setup` only while the deployment is still missing something required

- [#160](https://github.com/LuxorLabs/jardinero/pull/160) [`1402115`](https://github.com/LuxorLabs/jardinero/commit/140211500332ad6a3f4be2921c0e351601347f2a) Thanks [@luciocorral](https://github.com/luciocorral)! - github: never work a fork pull request, and with workflows.pr_maintainer.trusted_authors_only take PR maintenance only from someone who can push or an installed App

- [#158](https://github.com/LuxorLabs/jardinero/pull/158) [`087b8e4`](https://github.com/LuxorLabs/jardinero/commit/087b8e40eca7c500dbd085225931538b92d398e4) Thanks [@luciocorral](https://github.com/luciocorral)! - dashboard: add `auth.proxy_jwt`, which refuses every `/dashboard` request that does not carry a valid JWT signed by the authenticating proxy

### Patch Changes

- [#155](https://github.com/LuxorLabs/jardinero/pull/155) [`05aaeb2`](https://github.com/LuxorLabs/jardinero/commit/05aaeb2da6b855415aaabadacb38d922ee4279e3) Thanks [@luciocorral](https://github.com/luciocorral)! - worker: forward the Codex auth.json into sandboxes without its refresh_token, so a run cannot refresh or revoke the orchestrator's login

- [#153](https://github.com/LuxorLabs/jardinero/pull/153) [`a6d1d06`](https://github.com/LuxorLabs/jardinero/commit/a6d1d06dfc0467e9737c4233c62ef759a7e6f400) Thanks [@luciocorral](https://github.com/luciocorral)! - worker: redact the full GitHub installation token, in the pod logs as well as in run artifacts

- [#157](https://github.com/LuxorLabs/jardinero/pull/157) [`dae7974`](https://github.com/LuxorLabs/jardinero/commit/dae7974815b9d85c74b99095bb04fc91c2ae69d1) Thanks [@luciocorral](https://github.com/luciocorral)! - worker: mask every secret a run was given, by value, in its events, artifacts, output log and result

- [#152](https://github.com/LuxorLabs/jardinero/pull/152) [`1ad8eaf`](https://github.com/LuxorLabs/jardinero/commit/1ad8eaf839c5dd85ae7f1d40b86547c565ecb030) Thanks [@luciocorral](https://github.com/luciocorral)! - transport: refuse a request whose path the URL parser rewrites, so `/webhooks/github/%2e%2e/%2e%2e/dashboard` no longer reaches the dashboard

- [#159](https://github.com/LuxorLabs/jardinero/pull/159) [`3bf8ce0`](https://github.com/LuxorLabs/jardinero/commit/3bf8ce0eb945a5dc3a6eb3d8fb53e55db498d176) Thanks [@luciocorral](https://github.com/luciocorral)! - worker: mint each run's GitHub token with only the permissions its agent needs

## [0.11.1] - 2026-10-27

### Patch Changes

- [#150](https://github.com/LuxorLabs/jardinero/pull/150) [`6c3bb61`](https://github.com/LuxorLabs/jardinero/commit/6c3bb611d054d8420616d4717799939eef08edcd) Thanks [@luciocorral](https://github.com/luciocorral)! - worker: re-create the commits a run pushed through the GitHub API, so GitHub signs them and a branch that requires signed commits can merge the pull request

- [#149](https://github.com/LuxorLabs/jardinero/pull/149) [`5830ba2`](https://github.com/LuxorLabs/jardinero/commit/5830ba2d01e30ffdb53482512dd4473653cc141f) Thanks [@luciocorral](https://github.com/luciocorral)! - discord: link tickets and pull requests in messages, and quote the `/jardinero-code` request in the message that opens its thread

## [0.11.0] - 2026-10-27

### Minor Changes

- [#94](https://github.com/LuxorLabs/jardinero/pull/94) [`a598d44`](https://github.com/LuxorLabs/jardinero/commit/a598d44172316f64639a235b563e2a980f76ebed) Thanks [@luciocorral](https://github.com/luciocorral)! - worker: run Codex detached in the sandbox and poll it, so a lost stream or an orchestrator restart no longer loses the run

### Patch Changes

- [#146](https://github.com/LuxorLabs/jardinero/pull/146) [`01b8898`](https://github.com/LuxorLabs/jardinero/commit/01b88986c12c2eef39d49ef930fe83cff3383c63) Thanks [@luciocorral](https://github.com/luciocorral)! - linear: write the repository a `/jardinero-code` resolved into the ticket it opens, and route a ticket that names several of the team's repositories and has no project to the last one it names

- [#107](https://github.com/LuxorLabs/jardinero/pull/107) [`c6739a6`](https://github.com/LuxorLabs/jardinero/commit/c6739a633514cdb7b5c699c6f10f8019ad9b0a67) Thanks [@cbascom](https://github.com/cbascom)! - worker: always pass the Daytona API endpoint to the SDK, so an empty `DAYTONA_API_URL` in `.env` no longer fails every sandbox create

- [#96](https://github.com/LuxorLabs/jardinero/pull/96) [`ed5b121`](https://github.com/LuxorLabs/jardinero/commit/ed5b1213056527704cd1ae2ed6fe340f92274713) Thanks [@luciocorral](https://github.com/luciocorral)! - orchestrator: close a PR maintainer that ran out of attempts when its pull request ends and the webhook is lost

- [#97](https://github.com/LuxorLabs/jardinero/pull/97) [`e97f9bb`](https://github.com/LuxorLabs/jardinero/commit/e97f9bb92585a523e49536405ab11eea34039ce3) Thanks [@luciocorral](https://github.com/luciocorral)! - orchestrator: continue the pull request a failed Linear implementer run opened instead of opening another

- [#98](https://github.com/LuxorLabs/jardinero/pull/98) [`ab1cc35`](https://github.com/LuxorLabs/jardinero/commit/ab1cc35224fbf942ac29563f143965dfda1a5625) Thanks [@luciocorral](https://github.com/luciocorral)! - orchestrator: stop the workflow when an operator kills its sandbox run instead of dispatching another one

- [#95](https://github.com/LuxorLabs/jardinero/pull/95) [`dfdd379`](https://github.com/LuxorLabs/jardinero/commit/dfdd379fbd652c6c9789c1b20444e809f90929b7) Thanks [@luciocorral](https://github.com/luciocorral)! - orchestrator: end the Linear and Fix instances that own a pull request when it is merged or closed

- [#122](https://github.com/LuxorLabs/jardinero/pull/122) [`57a019d`](https://github.com/LuxorLabs/jardinero/commit/57a019dc82d2d3aa5c0a061b9c0d384a41e6d607) Thanks [@cbascom](https://github.com/cbascom)! - worker: size sandboxes from the image's native snapshot size, sending cpu/memory only to size up a repo with a `resources` override, so Tenki's new restore-floor enforcement stops rejecting log_review and under-sized runs

## [0.10.1] - 2026-09-26

### Patch Changes

- [#90](https://github.com/LuxorLabs/jardinero/pull/90) [`f93cccb`](https://github.com/LuxorLabs/jardinero/commit/f93cccbaa4c2b33003dcfba74c049f548d06316d) Thanks [@luciocorral](https://github.com/luciocorral)! - agent: take a linear implementation that declares no pull request as an answer instead of a failure

## [0.10.0] - 2026-09-26

### Minor Changes

- [`e0b3764`](https://github.com/LuxorLabs/jardinero/commit/e0b37646fd09bd77de614fa5069f55562b160ee2) Thanks [@luciocorral](https://github.com/luciocorral)! - config: default to the gpt-6 generation

- [#59](https://github.com/LuxorLabs/jardinero/pull/59) [`7046491`](https://github.com/LuxorLabs/jardinero/commit/7046491422e2ba9c8514cc404ba6ff7814c603ff) Thanks [@rishijoshi](https://github.com/rishijoshi)! - log-review: ignore per-target log noise and retry a scan whose run was lost, up to max_iterations

- [#77](https://github.com/LuxorLabs/jardinero/pull/77) [`f5b23a6`](https://github.com/LuxorLabs/jardinero/commit/f5b23a68b026272345047236ce4bc4bdf956f276) Thanks [@luciocorral](https://github.com/luciocorral)! - agent: read a repository's GitHub App credential per repo

- [#76](https://github.com/LuxorLabs/jardinero/pull/76) [`0a54bb3`](https://github.com/LuxorLabs/jardinero/commit/0a54bb341f07cfcf41ac29728320b956a78dd565) Thanks [@cbascom](https://github.com/cbascom)! - infra: add a Daytona sandbox smoke and run it nightly and on SDK bumps

- [#73](https://github.com/LuxorLabs/jardinero/pull/73) [`3497aff`](https://github.com/LuxorLabs/jardinero/commit/3497affa0ba25d8850c192a795322e7301219b08) Thanks [@cbascom](https://github.com/cbascom)! - infra: run the Freestyle sandbox smoke in CI and fix the documented snapshot build

### Patch Changes

- [#76](https://github.com/LuxorLabs/jardinero/pull/76) [`5ee0b45`](https://github.com/LuxorLabs/jardinero/commit/5ee0b4503c8e226f6ade1521ccc3eb76ff4be574) Thanks [@cbascom](https://github.com/cbascom)! - infra: emit the image build dry-run header on stderr so the script keeps its shebang

- [#71](https://github.com/LuxorLabs/jardinero/pull/71) [`5d7c156`](https://github.com/LuxorLabs/jardinero/commit/5d7c156be72c7670951cd93bfd12eb8649c72e0e) Thanks [@cbascom](https://github.com/cbascom)! - infra: add a dispatchable workflow that rebuilds a Tenki worker image

- [#76](https://github.com/LuxorLabs/jardinero/pull/76) [`bcc285f`](https://github.com/LuxorLabs/jardinero/commit/bcc285f1645a5a0cbfa91492acb57566122adb4b) Thanks [@cbascom](https://github.com/cbascom)! - infra: document the Daytona CLI login, its docs link and the key permissions Jardinero needs

- [#65](https://github.com/LuxorLabs/jardinero/pull/65) [`89e8825`](https://github.com/LuxorLabs/jardinero/commit/89e8825ccfed29ea705477efdba7c6edb6ca6e1c) Thanks [@renovate](https://github.com/apps/renovate)! - worker: follow the Freestyle SDK default to api.freestyle.sh

- [#54](https://github.com/LuxorLabs/jardinero/pull/54) [`b15c3f5`](https://github.com/LuxorLabs/jardinero/commit/b15c3f5804e56869db63eaffc26f41e30ac53733) Thanks [@cbascom](https://github.com/cbascom)! - worker: adopt the freestyle 0.2.7 VM lifetime options

- [#74](https://github.com/LuxorLabs/jardinero/pull/74) [`bf7184b`](https://github.com/LuxorLabs/jardinero/commit/bf7184b3025bfc2df214e61afcd46e4aca8a49b7) Thanks [@cbascom](https://github.com/cbascom)! - worker: run Freestyle provisioning as root so sandbox creation stops failing

- [#73](https://github.com/LuxorLabs/jardinero/pull/73) [`cb218b7`](https://github.com/LuxorLabs/jardinero/commit/cb218b77c3d3e31522719762b6df642bc038b6a6) Thanks [@cbascom](https://github.com/cbascom)! - worker: stop the Freestyle sudo check from blaming an unrelated provisioning failure

- [#53](https://github.com/LuxorLabs/jardinero/pull/53) [`bd5faa9`](https://github.com/LuxorLabs/jardinero/commit/bd5faa91339bf5076853eaa5358380ab24e1be6c) Thanks [@cbascom](https://github.com/cbascom)! - infra: upgrade pnpm to 12; a pnpm 11 that switches to it can leave a binary that fails with ENOEXEC, so install pnpm 12 directly

- [#60](https://github.com/LuxorLabs/jardinero/pull/60) [`20835b4`](https://github.com/LuxorLabs/jardinero/commit/20835b4786ca6ec008d6704550e48f47f3da967c) Thanks [@rishijoshi](https://github.com/rishijoshi)! - orchestrator: drop sandbox rows the pool refuses so a Fix loss streak is left intact

- [#70](https://github.com/LuxorLabs/jardinero/pull/70) [`0f01d51`](https://github.com/LuxorLabs/jardinero/commit/0f01d51ce47d1070bd4a0c1482e7304bf829ed38) Thanks [@cbascom](https://github.com/cbascom)! - infra: run the Tenki sandbox smoke in CI nightly and on SDK version changes

- [#75](https://github.com/LuxorLabs/jardinero/pull/75) [`eb34ca3`](https://github.com/LuxorLabs/jardinero/commit/eb34ca3fd33469c89c01d2ad7985c947bfb0bfe0) Thanks [@cbascom](https://github.com/cbascom)! - infra: drive the Tenki smoke through TenkiSandboxProvider instead of the SDK directly

## [0.9.0] - 2026-09-10

### Minor Changes

- [#31](https://github.com/LuxorLabs/jardinero/pull/31) [`b977fa6`](https://github.com/LuxorLabs/jardinero/commit/b977fa64b78f84a4e8ab8c749dd6da0f418c8644) Thanks [@mislavivanda](https://github.com/mislavivanda)! - worker: add Daytona sandbox runner support

- [#5](https://github.com/LuxorLabs/jardinero/pull/5) [`c3b6b06`](https://github.com/LuxorLabs/jardinero/commit/c3b6b06e4530b87ac50512105ddf3235e7bff44a) Thanks [@theswerd](https://github.com/theswerd)! - worker: add Freestyle VM runner support

- [#15](https://github.com/LuxorLabs/jardinero/pull/15) [`1c22d45`](https://github.com/LuxorLabs/jardinero/commit/1c22d45425dfed9608550e30f5a4e94caa2cc53a) Thanks [@cbascom](https://github.com/cbascom)! - Tenki SDK v1: sandboxes are scoped by workspace and TENKI_PROJECT_ID is gone.

### Patch Changes

- [#43](https://github.com/LuxorLabs/jardinero/pull/43) [`fb0970d`](https://github.com/LuxorLabs/jardinero/commit/fb0970d87f222d6369e91d2e2e22e27e812f502e) Thanks [@luciocorral](https://github.com/luciocorral)! - worker: wait for a Daytona session command's exit status instead of reading an unrecorded one as a failure

- [#42](https://github.com/LuxorLabs/jardinero/pull/42) [`e160ac6`](https://github.com/LuxorLabs/jardinero/commit/e160ac646737a2f0a7743f62c0a8de42d5037b9b) Thanks [@luciocorral](https://github.com/luciocorral)! - Scan every cluster a log-review target lists instead of refusing the run when the first one has no streams.

## [0.8.0] - 2026-08-27

### Minor Changes

- [`3e05d46`](https://github.com/LuxorLabs/jardinero/commit/3e05d4670d698fa198a4f47fa71751f50aad28ca) Thanks [@luciocorral](https://github.com/luciocorral)! - Build a worker image from recipes kept outside the repository.

### Patch Changes

- [#10](https://github.com/LuxorLabs/jardinero/pull/10) [`d474ac0`](https://github.com/LuxorLabs/jardinero/commit/d474ac007396abba01feb5fc7f952c6241d48350) Thanks [@cbascom](https://github.com/cbascom)! - Published images are built for linux/amd64 and linux/arm64.

- [#8](https://github.com/LuxorLabs/jardinero/pull/8) [`237bdd5`](https://github.com/LuxorLabs/jardinero/commit/237bdd53d843afd0e9bb94e6e7f95a968c153f3a) Thanks [@cbascom](https://github.com/cbascom)! - Published images are signed and carry build provenance and an SBOM.

## [0.7.0] - 2026-08-27

### Minor Changes

- [`dcbd1d5`](https://github.com/LuxorLabs/jardinero/commit/dcbd1d5cd25847b34a5477925b4f1857767fd96c) Thanks [@luciocorral](https://github.com/luciocorral)! - Publish an image on demand, without cutting a release.

## [0.6.0] - 2026-08-26

First public release.

The history before this point was developed privately and is squashed into the
first commit, so this changelog starts here.
