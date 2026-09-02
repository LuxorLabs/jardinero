# Deploying Jardinero

Two worked examples. Neither is a drop-in: both name a host, an image tag and a secret you have to replace with yours.

| | |
|---|---|
| [`docker-compose.yaml`](docker-compose.yaml) | One box. What most self-hosted installs want. |
| [`kubernetes/`](kubernetes/) | A cluster. Deployment, Service, Ingress and PVC, with kustomize. |
| [`kubernetes/config.yaml`](kubernetes/config.yaml) | The configuration both mount. Replace every value in it. It sits under `kubernetes/` because kustomize refuses a file outside its own directory. |

[`../../docs/setup.md`](../../docs/setup.md) is how you get the credentials these need.

## What both encode

**One instance, always.** State is SQLite on one volume, which tolerates exactly one writer. The Kubernetes example says so twice, with `replicas: 1` and `strategy: Recreate`, because a rolling update would otherwise mount the volume into two pods at once. Scaling this does not share load, it corrupts the database.

**The volume is the product.** It holds the database, the hourly backups written beside it, and the artifacts of every sandbox run. Those backups protect you from a corrupted file, not from losing the disk, so back the volume up somewhere else too.

**Authentication is in front, not inside.** Jardinero has no login: it reads the identity an authenticating proxy sets on the request. Whoever reaches an unprotected deployment can operate it. `/admin/*` and `/capsule/*` are separately guarded by `ORCHESTRATOR_ADMIN_TOKEN`, and `/capsule/sql` runs read-only SQL over the whole database, so that token is not optional either.

**The host has to be reachable.** GitHub, Linear and Discord deliver over webhooks. An install nothing can reach is an install where nothing ever happens.

**Configuration is a mounted file, not an edited checkout.** Point `CONFIG_PATH` at it. It is the whole configuration: there is no merge across files, and every key it omits takes its code default. `../../docs/configuration.md` is the reference.

## Verifying the image

The published images are signed, so you can check an image really came from this repository before you run it. Either check is sufficient; they assert the same thing by different routes.

With [cosign](https://docs.sigstore.dev/cosign/installation/):

```bash
cosign verify ghcr.io/luxorlabs/jardinero:vX.Y.Z \
  --certificate-identity-regexp '^https://github\.com/LuxorLabs/jardinero/\.github/workflows/publish-image\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The identity regexp is the point: it pins the signature to this repository's publish workflow running on a release tag. Verifying without it only tells you the image was signed by someone.

With the GitHub CLI:

```bash
gh attestation verify oci://ghcr.io/luxorlabs/jardinero:vX.Y.Z --repo LuxorLabs/jardinero
```

If you build your own images from a fork, both commands take your own repository in place of `LuxorLabs/jardinero`.

## Upgrading

Both examples above track `latest`. Pin a fixed version for anything you care about, so a rollback is a value change:

```yaml
image: ghcr.io/luxorlabs/jardinero:vX.Y.Z
```

The schema is applied on every boot and only ever adds, so a newer image reads an older database. Going backwards is not covered: take a copy of the volume before an upgrade you might want to undo.
