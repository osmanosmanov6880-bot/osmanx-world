#!/usr/bin/env bash
# R7 operator-only stage coordinator. Never alters live Nginx, production DB or site.
set -euo pipefail
umask 077
mode="${1:-plan}"
envfile="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
case "$mode" in plan|apply|stop) ;; *) echo "Usage: stage-launch.sh plan|apply|stop /absolute/path/to/private.env" >&2;exit 2;; esac
[[ "$envfile" = /* ]] || { echo "Use an absolute path for the private env file" >&2; exit 2; }
envfile="$(realpath -e "$envfile")"
[[ "$envfile" != "$ROOT/"* ]] || { echo "Secrets must be outside the Git checkout and public assets" >&2;exit 2; }
test -f "$envfile" && test ! -L "$envfile"
test -z "${DOCKER_HOST:-}" && test -z "${DOCKER_CONTEXT:-}" || {
  echo "Remote Docker contexts are forbidden" >&2;exit 2;
}
command -v docker >/dev/null && command -v node >/dev/null && command -v curl >/dev/null || {
  echo "Docker, Node and curl are required" >&2; exit 2;
}
test "$(docker context show)" = default || { echo "Only local default Docker context is permitted" >&2;exit 2; }
docker info >/dev/null
node "$ROOT/scripts/preflight.mjs" "$envfile" >/dev/null
dc=(docker compose --env-file "$envfile" -f "$ROOT/ops/compose.staging.yml" -p osmanx-industry-r7-staging)
"${dc[@]}" config --quiet
if [[ "$mode" == plan ]]; then
  echo "R7 isolated staging plan VERIFIED (no changes made)"
  echo "Project: osmanx-industry-r7-staging"
  echo "Loopback: 127.0.0.1:3149; separate volume and private network"
  echo "Guest writes: disabled; no webhook worker, public DNS or Nginx changes"
  exit 0
fi
if [[ "${R7_STAGE_ACK:-}" != "CONFIRM_ISOLATED_STAGE_ONLY" ]]; then
  echo "Explicit R7_STAGE_ACK=CONFIRM_ISOLATED_STAGE_ONLY required" >&2;exit 2
fi
if [[ "$mode" == stop ]]; then
  "${dc[@]}" stop api
  echo "Stopped ONLY staging API; database and volume preserved."
  exit 0
fi
if [[ -n "$("${dc[@]}" ps -q)" ]]; then
  echo "Staging project already exists. No automatic overwrite." >&2;exit 2
fi
if command -v ss >/dev/null && ss -ltn | grep -Eq '(^|:)3149[[:space:]]'; then
  echo "Loopback staging port 3149 occupied; refusing changes" >&2;exit 2
fi
"${dc[@]}" up -d db
# Failures leave the isolated staging DB for investigation; never delete volumes.
"${dc[@]}" --profile setup run --rm provision
"${dc[@]}" --profile setup run --rm migrate
"${dc[@]}" --profile setup run --rm bootstrap
"${dc[@]}" up -d api
ready=0
for attempt in $(seq 1 40); do
  if curl --silent --fail --max-time 3 \
      http://127.0.0.1:3149/api/industry/v1/health/ready |
      grep -q '"guestWritesEnabled":false'; then
    ready=1;break
  fi
  sleep 2
done
if [[ "$ready" != 1 ]]; then
  "${dc[@]}" stop api >/dev/null 2>&1 || true
  echo "Staging unhealthy. API stopped; DB kept for inspection." >&2
  exit 1
fi
read_status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 \
  http://127.0.0.1:3149/api/industry/v1/guest/pilots)"
write_status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 \
  -X POST -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:3149/api/industry/v1/guest/requests)"
if [[ "$read_status" != 401 || "$write_status" != 503 ]]; then
  "${dc[@]}" stop api >/dev/null 2>&1 || true
  echo "Staging safety gate failed. API stopped; volume preserved." >&2
  exit 1
fi
echo "R7 STAGING READY: live site untouched; protected GET 401; Guest mutation 503."
echo "Independent two-person staging acceptance is still required."
