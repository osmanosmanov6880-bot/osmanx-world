#!/usr/bin/env bash
# R14 canary supervisor. No production deployment, Nginx changes or write enable.
set -euo pipefail
umask 077
mode="${1:-}"
envfile="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
usage(){ echo "Usage: bash ops/r14-canary.sh plan|apply|health|stop /absolute/private.env" >&2; exit 2; }
[[ "$mode" == plan || "$mode" == apply || "$mode" == health || "$mode" == stop ]] || usage
[[ "$envfile" == /* ]] || usage
test -f "$envfile" && test ! -L "$envfile" || { echo "Refusing symlink or missing private env";exit 2; }
envfile="$(realpath -e "$envfile")"
[[ "$envfile" != "$ROOT/"* ]] || { echo "Secrets inside checkout forbidden";exit 2; }
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || { echo "Refusing remote Docker contexts";exit 2; }
for cmd in docker node curl; do command -v "$cmd" >/dev/null || { echo "Missing dependency $cmd";exit 2; };done
[[ "$(docker context show)" == default ]] || { echo "Only local Docker allowed";exit 2; }
docker info >/dev/null
node "$ROOT/scripts/preflight.mjs" "$envfile" >/dev/null
project="osmanx-guest-r14-canary"
compose=(docker compose -p "$project" --env-file "$envfile" -f "$ROOT/ops/compose.r14.yml")
"${compose[@]}" config --quiet
if [[ "$mode" == plan ]]; then
  echo "R14 plan: isolated canary, loopback 3150, encrypted offsite DR required before customer launch"
  echo "Writes disabled; Nginx, production services and DNS unchanged"
  exit 0
fi
if [[ "$mode" == health ]]; then
  node "$ROOT/scripts/r14-monitor.mjs" --local
  exit $?
fi
[[ "${R14_CANARY_ACK:-}" == "CONFIRM_ISOLATED_R14_NO_CUSTOMERS" ]] || {
  echo "Explicit R14_CANARY_ACK required";exit 2;
}
if [[ "$mode" == stop ]]; then
  "${compose[@]}" stop api
  echo "Only R14 canary API stopped; data volume preserved."
  exit 0
fi
if [[ -n "$("${compose[@]}" ps -aq)" ]] ||
   [[ -n "$(docker volume ls --filter label=com.docker.compose.project="$project" --quiet)" ]]; then
  echo "Existing canary state detected. Refusing automatic overwrite or replay."
  exit 2
fi
if command -v ss >/dev/null && ss -ltn | grep -Eq '(^|:)3150[[:space:]]'; then
  echo "Port 3150 is already bound";exit 2
fi
"${compose[@]}" up -d db
"${compose[@]}" --profile setup run --rm provision
"${compose[@]}" --profile setup run --rm migrate
"${compose[@]}" --profile setup run --rm bootstrap
"${compose[@]}" up -d api
ready=0
for attempt in $(seq 1 40); do
  if node "$ROOT/scripts/r14-monitor.mjs" --local >/dev/null 2>&1; then ready=1;break;fi
  sleep 2
done
if [[ "$ready" != 1 ]]; then
  "${compose[@]}" stop api >/dev/null 2>&1 || true
  echo "R14 API readiness/security failed. API stopped, database preserved." >&2
  exit 1
fi
echo "R14 canary healthy; NO public exposure and NO customer data accepted."
