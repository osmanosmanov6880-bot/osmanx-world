# Original 180 — Wave 1 reproducible builds / dependency recovery

Original IDs: **TITAN-X04 and TITAN-X05**, local implementations only.

## Reproducible evidence package

`campaign180.repro` builds a deterministic gzip-compressed tar from **clean
tracked git files**, bundling this campaign's source, the October 17 original
master and original task JSON. Stable order, metadata, gzip header and canonical
JSON manifest are verified offline; every source byte is SHA-256 hashed.
Symlinks, noncanonical paths, nonclean worktrees, oversized archives and
tampering are rejected. The CLI can optionally sign SHA-256 archive digests with
an external Ed25519 private key using OpenSSL; verification needs the public key.

```bash
PYTHONPATH=supreme-director/campaign180 python -m campaign180.repro build --root . --archive /tmp/campaign180.tgz
PYTHONPATH=supreme-director/campaign180 python -m campaign180.repro verify --archive /tmp/campaign180.tgz
# Optional: keys must be supplied OUTSIDE the repository
PYTHONPATH=supreme-director/campaign180 python -m campaign180.repro sign --archive /tmp/campaign180.tgz --key /secure/private.pem --signature /tmp/campaign180.sig
PYTHONPATH=supreme-director/campaign180 python -m campaign180.repro verify-signature --archive /tmp/campaign180.tgz --key /secure/public.pem --signature /tmp/campaign180.sig
```

There is **no release signing key provisioned**, no provenance certificate
from the independent owner, no upstream KRAKEN build, and no auto deploy.
An ephemeral CI test key proves only that sign/verify code works.

## Offline dependency preflight

`campaign180.offline_deps` requires exact version and SHA-256 wheel locks,
rejects network/index directives, and validates a single local wheel per entry.
Default mode only reads files. An explicit `--target` triggers pip with
`--no-index --require-hashes` into a new/empty, local directory; **never** use
untrusted wheels or live environments. This does not restore missing test
dependencies from all six upstream products. Those remain blocked.

```bash
PYTHONPATH=supreme-director/campaign180 python -m campaign180.offline_deps ./requirements.lock ./wheelhouse
# optional verified, offline install into a disposable dir:
PYTHONPATH=supreme-director/campaign180 python -m campaign180.offline_deps ./requirements.lock ./wheelhouse --target /tmp/offline-test-libs
```

**Acceptance remains 0/180.** Roll back by reverting this branch commit;
the package builder has no persistent migrations. Keep signing private keys
outside Git and never mistake signatures made by local test keys for an
independent release approval.
