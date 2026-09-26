# jardinero

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
