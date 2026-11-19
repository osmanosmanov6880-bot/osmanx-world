#!/usr/bin/env bash
# Verify content integrity of a R6 release from CI before ANY operator deploy.
# SHA256SUMS detects corruption; it is NOT a cryptographic publisher signature.
set -euo pipefail
umask 077
if (( $# != 1 )); then echo "Usage: bash ops/verify-release.sh RELEASE.tar.gz" >&2; exit 2; fi
archive="$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
name="$(basename "$archive")"
[[ "$name" =~ ^osmanx-industry-[a-f0-9]{12}\.tar\.gz$ ]] || {
  echo "Unknown release filename" >&2; exit 2;
}
test -f "$archive" && test -f "$archive.sha256" || {
  echo "Missing archive or checksum" >&2; exit 2;
}
(
  cd "$(dirname "$archive")"
  sha256sum -c -- "$name.sha256" >/dev/null
)
test "$(stat -c %s "$archive")" -le 10485760 || {
  echo "Archive exceeds size limit" >&2; exit 3;
}
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP TERM INT
tar -tzf "$archive" > "$tmp/members.txt"
# Reject duplicate paths and special link/device types BEFORE extraction.
if LC_ALL=C sort "$tmp/members.txt" | uniq -d | grep -q .; then
  echo "Duplicate archive path" >&2;exit 3
fi
if tar -tzvf "$archive" | cut -c1 | grep -Eq '^[^d-]'; then
  echo "Links and special tar entries are not permitted" >&2;exit 3
fi
while IFS= read -r path; do
  [[ "$path" == "industry-api" || "$path" == industry-api/* ]] || {
    echo "Archive has path outside industry-api/" >&2; exit 3;
  }
  [[ "$path" != /* && "$path" != *"/../"* && "$path" != *"/./"* && "$path" != *"/.." &&
     "$path" != *"//"* ]] || {
    echo "Unsafe archive path" >&2; exit 3;
  }
done < "$tmp/members.txt"
tar -xzf "$archive" -C "$tmp" --no-same-owner --no-same-permissions
root="$tmp/industry-api"
test -d "$root" && test -f "$root/SHA256SUMS"
test -f "$root/Dockerfile" && test -f "$root/compose.yml"
test -f "$root/shared/pilot-model.js" && test -f "$root/src/guest.mjs"
test -f "$root/ops/compose.staging.yml" && test -f "$root/ops/stage-launch.sh"
test -f "$root/ops/r10-operator-gate.sh" && test -f "$root/scripts/r10-stage-gate.mjs"
test -f "$root/ops/compose.r14.yml" && test -f "$root/ops/r14-canary.sh"
test -f "$root/scripts/r14-monitor.mjs" && test -f "$root/scripts/r14-admission.mjs"
test -f "$root/scripts/r14-incident.mjs"
test -f "$root/RELEASE.json"
revision="${name#osmanx-industry-}"
revision="${revision%.tar.gz}"
grep -Fq "\"commit\":\"$revision\"" "$root/RELEASE.json" || {
  echo "Release revision does not match archive" >&2;exit 3;
}
grep -Fq '"schema":"osmanx.industry.r14.release.v1"' "$root/RELEASE.json" || {
  echo "R10 release schema missing" >&2;exit 3;
}
grep -Fq '"migration":"011_guest_pilot_safety.sql"' "$root/RELEASE.json" || {
  echo "R9 database migration missing" >&2;exit 3;
}
grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
  echo "Release lacks fail-closed write gate" >&2;exit 3;
}
# R18 extensions are required only in R18 release bundles; legacy R14
# archives remain verifiable, but they are NOT R18 production acceptance.
if grep -Fq '"externalAnchorRequiredForR18":true' "$root/RELEASE.json"; then
  grep -Fq '"latestMigration":"013_guest_external_anchor_fence.sql"' "$root/RELEASE.json" || {
    echo "Missing R18 schema declaration" >&2;exit 3;
  }
  full_sha="$(sed -n 's/.*"fullCommit":"\([a-f0-9]\{40\}\)".*/\1/p' "$root/RELEASE.json")"
  [[ "$full_sha" =~ ^[a-f0-9]{40}$ ]] && test "$(printf '%.12s' "$full_sha")" = "$revision" || {
    echo "R18 full commit does not match source release" >&2;exit 3;
  }
  for entry in migrations/013_guest_external_anchor_fence.sql \
    src/guest-r18-anchor.mjs src/guest-r18-fence.mjs src/guest-r18-proof.mjs \
    scripts/r18-dr-rehearsal.mjs scripts/r18-proof.mjs \
    scripts/r18-anchor-signer.mjs scripts/r18-release-gate.mjs; do
    test -f "$root/$entry" || {
      echo "R18 release missing $entry" >&2;exit 3;
    }
  done
fi
if find "$root" -type l -print -quit | grep -q .; then
  echo "Archive contains links" >&2; exit 3
fi
if find "$root" -type f \( -name .env -o -name '*.key' -o -name '*.pem' \
    -o -name '*.age' -o -name identity.txt \) -print -quit | grep -q .; then
  echo "Archive contains credential-shaped file" >&2; exit 3
fi
(
  cd "$root"
  sha256sum -c -- SHA256SUMS >/dev/null
  entries="$(wc -l < SHA256SUMS)"
  actual="$(find . -type f ! -name SHA256SUMS | wc -l)"
  test "$entries" -eq "$actual" || { echo "Unexpected files in bundle" >&2; exit 3; }
)
echo "R14 release integrity: verified $name"
echo "Next step is operator staging, not production deployment."
