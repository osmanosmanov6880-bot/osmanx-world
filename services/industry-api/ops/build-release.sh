#!/usr/bin/env bash
# Guest R6: deterministic, secret-free, operator-installable source release.
# Writes only to a selected output directory; does NOT deploy, migrate or create credentials.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPO="$(cd "$ROOT/../.." && pwd -P)"
OUT="${1:-$ROOT/dist}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
test -d "$ROOT/src" && test -d "$ROOT/shared" && test -d "$ROOT/migrations"

if command -v git >/dev/null 2>&1 && git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  VERSION="$(git -C "$REPO" rev-parse --short=12 HEAD)"
  FULL_SHA="$(git -C "$REPO" rev-parse HEAD)"
else
  echo "Refusing unversioned source bundle: git commit is required" >&2
  exit 2
fi
[[ "$VERSION" =~ ^[0-9a-f]{12}$ ]] || { echo "Invalid commit revision" >&2; exit 2; }
[[ "$FULL_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "R18 full commit SHA required" >&2; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT HUP TERM
dst="$tmp/industry-api"
mkdir -p "$dst"/{src,shared,migrations,scripts,ops}
for name in Dockerfile compose.yml package.json; do
  cp -- "$ROOT/$name" "$dst/$name"
done
for name in src shared migrations scripts; do
  cp -R -- "$ROOT/$name/." "$dst/$name/"
done
# Explicit allowlist; never copy .env, credentials, backups, archives, identity files.
for name in .env.example Dockerfile.backup nginx-industry.conf provision-roles.sh \
  backup-encrypted.sh restore-dr.sh runtime-check.sh build-release.sh verify-release.sh \
  compose.staging.yml stage-launch.sh r10-operator-gate.sh \
  compose.r14.yml r14-canary.sh; do
  cp -- "$ROOT/ops/$name" "$dst/ops/$name"
done

if find "$dst" -type l -print -quit | grep -q .; then
  echo "Refusing symlinks in release inputs" >&2; exit 3
fi
if find "$dst" -type f \( -name '.env' -o -name '*.key' -o -name '*.pem' -o -name '*.age' \
  -o -name 'identity.txt' -o -name '*private*' -o -name '*secret*' \) -print -quit | grep -q .; then
  echo "Refusing potential credential material in release" >&2; exit 3
fi

# Machine-readable, non-secret release contract; pinned to this exact Git tree.
printf '{"schema":"osmanx.industry.r14.release.v1","commit":"%s","fullCommit":"%s","migration":"011_guest_pilot_safety.sql","latestMigration":"016_guest_r26_source_reviews.sql","r19Migration":"014_guest_single_pilot_rollout.sql","externalAnchorRequiredForR18":true,"singlePilotScopeSupportedR19":true,"releaseReviewSupportedR20":true,"hostPostureSupportedR21":true,"independentReadinessSupportedR22":true,"manualStagingSupportedR23":true,"decisionIntelligenceSupportedR24":true,"operationalHypothesesSupportedR25":true,"sourceReliabilitySupportedR26":true,"firstClientRehearsalSupportedR27":true,"independentReleaseReviewSupportedR28":true,"virtualMergeStagingSupportedR29":true,"guestWritesDefault":false}\n' "$VERSION" "$FULL_SHA" > "$dst/RELEASE.json"
# Only the output artifact name references a commit SHA. No data from the live environment.
(
  cd "$dst"
  find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z |
    xargs -0 -r sha256sum > SHA256SUMS
)
archive="osmanx-industry-${VERSION}.tar.gz"
# Fixed file order, timestamps, owner and gzip headers => identical source builds.
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  -C "$tmp" -cf - industry-api | gzip -n -9 > "$OUT/$archive"
(cd "$OUT" && sha256sum "$archive" > "$archive.sha256")
test -s "$OUT/$archive" && test -s "$OUT/$archive.sha256"
printf 'R14 release packaged: %s\n' "$OUT/$archive"
printf 'R14 archive checksum: %s\n' "$OUT/$archive.sha256"
printf 'Source commit: %s\n' "$VERSION"
printf 'No secrets included, no infrastructure changed.\n'
