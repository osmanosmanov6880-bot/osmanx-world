#!/bin/sh
# Read-only preflight. No host settings, services or data are mutated.
set -eu
echo "OSMANX Industry API infrastructure readiness"
for bin in docker nginx openssl; do
  if command -v "$bin" >/dev/null 2>&1; then echo "$bin: installed"; else echo "$bin: MISSING"; fi
done
if docker compose version >/dev/null 2>&1; then echo "docker compose: installed"; else echo "docker compose: MISSING"; fi
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo "docker daemon: available"; else echo "docker daemon: unavailable"; fi
if test -w /etc/nginx/sites-enabled; then echo "nginx config: writable"; else echo "nginx config: administrator required"; fi
if test -f .env; then
  mode=$(stat -c %a .env)
  echo "local secrets file mode: $mode"
  if test "$mode" != 600; then echo "Warning: .env should be chmod 600" >&2; fi
else
  echo "local .env: not provisioned"
fi
