#!/usr/bin/env bash
# R10 read-only operator GO/NO-GO report for an already-launched isolated staging stack.
# Never creates users, migrates DB, changes Nginx, uploads secrets or enables Guest writes.
set -euo pipefail
umask 077
if (( $#!=2 )); then
  echo "Usage: bash ops/r10-operator-gate.sh /absolute/private.env /absolute/osmanx-industry-HASH.tar.gz" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
test "$1" = /* && test "$2" = /* || {
  echo "Absolute paths are mandatory" >&2;exit 2;
}
test ! -L "$1" && test ! -L "$2" || {
  echo "NO-GO: links to credentials or release archives are forbidden" >&2; exit 2;
}
envfile="$(realpath -e "$1")"
release="$(realpath -e "$2")"
[[ "$envfile" != "$ROOT/"* ]] || {
  echo "NO-GO: private credentials inside source checkout" >&2;exit 2;
}
test -f "$envfile" && test ! -L "$envfile" || {
  echo "NO-GO: environment file must be a private regular file" >&2;exit 2;
}
test -f "$release" && test ! -L "$release" || {
  echo "NO-GO: source release must be a regular archive" >&2;exit 2;
}
test -z "${DOCKER_HOST:-}" && test -z "${DOCKER_CONTEXT:-}" || {
  echo "NO-GO: remote Docker contexts forbidden" >&2;exit 2;
}
for bin in docker node curl; do
  command -v "$bin" >/dev/null || { echo "NO-GO: required tool missing: $bin" >&2;exit 2; }
done
test "$(docker context show)" = default || {
  echo "NO-GO: non-default Docker context" >&2;exit 2;
}
docker info >/dev/null 2>&1 || {
  echo "NO-GO: local Docker daemon permission required" >&2;exit 2;
}
node "$ROOT/scripts/preflight.mjs" "$envfile" >/dev/null || {
  echo "NO-GO: private configuration failed validation; inspect locally, never post credentials" >&2;exit 2;
}
docker compose --env-file "$envfile" -f "$ROOT/ops/compose.staging.yml" \
  -p osmanx-industry-r7-staging config --quiet || {
  echo "NO-GO: isolated staging compose invalid" >&2;exit 2;
}
bash "$ROOT/ops/verify-release.sh" "$release" >/dev/null || {
  echo "NO-GO: source release checksum/manifest invalid" >&2;exit 2;
}
node "$ROOT/scripts/r10-stage-gate.mjs" --require-ready >/dev/null || {
  echo "NO-GO: isolated staging R9 security checks not satisfied" >&2;exit 2;
}
echo "R10 TECHNICAL STAGING: PASS"
echo "Source integrity, private environment, local Docker and staged API safety gates verified."
echo "CUSTOMER LAUNCH: NOT AUTHORIZED by this command."
echo "Before live customers: two-person acceptance, independent off-host DR, admin Nginx/TLS review,"
echo "lawful processing agreements, monitoring, rate limits and explicit owner authorization required."
