# jardinero

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
