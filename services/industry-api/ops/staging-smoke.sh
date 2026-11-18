#!/usr/bin/env bash
# R6 isolated CI-only smoke for the production Docker image.
# Rejects remote Docker contexts and non-CI database targets.
set -euo pipefail
if [[ "${R6_STAGE_ALLOWED:-}" != "CI_ONLY" ]]; then
  echo "Refusing outside an isolated CI run" >&2; exit 2
fi
if [[ -n "${DOCKER_HOST:-}" ]] || [[ "$(docker context show)" != "default" ]]; then
  echo "Refusing remote Docker context" >&2; exit 2
fi
if [[ "${R6_STAGE_DB_URL:-}" != postgresql://industry_app:*@127.0.0.1:5432/industry_ci ]]; then
  echo "Refusing non-CI PostgreSQL target" >&2; exit 2
fi
name="osmanx-r6-ci-$$"
cleanup(){ docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
if curl --silent --max-time 2 http://127.0.0.1:3147/api/industry/v1/health/live >/dev/null 2>&1; then
  echo "Port 3147 already has a live API; refusing collision" >&2; exit 2
fi
docker run --detach --network host --name "$name" \
  -e NODE_ENV=production -e ALLOWED_ORIGIN=https://osmanx.world \
  -e BIND_HOST=127.0.0.1 -e PORT=3147 \
  -e GUEST_WRITES_ENABLED=false -e DATABASE_URL="$R6_STAGE_DB_URL" \
  osmanx-industry-api:r6-ci >/dev/null
ready=0
for attempt in $(seq 1 35); do
  if curl --silent --fail --max-time 3 \
     http://127.0.0.1:3147/api/industry/v1/health/ready |
     grep -q '"guestWritesEnabled":false'; then
    ready=1;break
  fi
  sleep 1
done
test "$ready" -eq 1 || { echo "R6 Docker health/readiness failed" >&2; exit 1; }
getStatus(){
  curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --max-time 5 "$@"
}
private="$(getStatus http://127.0.0.1:3147/api/industry/v1/guest/pilots)"
evidence="$(getStatus http://127.0.0.1:3147/api/industry/v1/guest/pilots/00000000-0000-4000-8000-000000000000/evidence.json)"
disabled="$(getStatus -X POST -H 'Content-Type: application/json' -d '{}' \
    http://127.0.0.1:3147/api/industry/v1/guest/requests)"
test "$private" = 401 || { echo "Unauthenticated list not blocked" >&2; exit 1; }
test "$evidence" = 401 || { echo "Unauthenticated proof not blocked" >&2; exit 1; }
test "$disabled" = 503 || { echo "Guest writes not fail-closed" >&2; exit 1; }
echo "R6 production-image acceptance PASS: ready, unauthorized 401, disabled writes 503"
echo "The test container will be removed. No production service was touched."
