#!/bin/sh
# Disposable provisioning container only. Never executed by public HTTP server.
set -eu
test -n "$INDUSTRY_APP_PASSWORD"
test -n "$INDUSTRY_WORKER_PASSWORD"
test -n "$PGHOST"
test -n "$PGUSER"
test -n "$PGDATABASE"
case "$INDUSTRY_APP_PASSWORD:$INDUSTRY_WORKER_PASSWORD" in
  *[!0-9A-Za-z_:]* ) echo 'Only alphanumeric/underscore role passwords allowed' >&2; exit 1;;
esac
test "$(printf %s "$INDUSTRY_APP_PASSWORD" | wc -c)" -ge 32
test "$(printf %s "$INDUSTRY_WORKER_PASSWORD" | wc -c)" -ge 32
psql -X -v ON_ERROR_STOP=1 -v app_pw="$INDUSTRY_APP_PASSWORD" -v worker_pw="$INDUSTRY_WORKER_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE industry_app LOGIN PASSWORD %L NOBYPASSRLS', :'app_pw')
 WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='industry_app') \gexec
SELECT format('ALTER ROLE industry_app WITH LOGIN PASSWORD %L NOBYPASSRLS', :'app_pw') \gexec
SELECT format('CREATE ROLE industry_worker LOGIN PASSWORD %L BYPASSRLS', :'worker_pw')
 WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='industry_worker') \gexec
SELECT format('ALTER ROLE industry_worker WITH LOGIN PASSWORD %L BYPASSRLS', :'worker_pw') \gexec
SQL
echo 'Industry SQL roles ready (no secrets printed)'
