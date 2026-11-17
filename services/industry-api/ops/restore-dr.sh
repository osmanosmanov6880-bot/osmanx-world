#!/bin/sh
# Restore test into a separately named, EMPTY industry_dr_* database.
# NO production restore path exists in this script.
set -eu
umask 077
test -n "$DR_RESTORE_DB_URL"
test -n "$AGE_IDENTITY_FILE"
archive="$1"
test -f "$archive"
test -f "$archive.sha256"
name=$(basename "$archive")
archive_dir=$(dirname "$archive")
(
 cd "$archive_dir"
 sha256sum -c "$name.sha256"
)
database=$(psql -X -At --dbname="$DR_RESTORE_DB_URL" -c 'SELECT current_database()')
case "$database" in
  industry_dr_*) ;;
  *) echo 'Refusing restore: target database must begin industry_dr_' >&2; exit 1;;
esac
existing=$(psql -X -At --dbname="$DR_RESTORE_DB_URL" -c "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='industry')")
if test "$existing" != f; then echo 'Refusing restore: target already has industry schema' >&2; exit 1; fi
psql -X -v ON_ERROR_STOP=1 --dbname="$DR_RESTORE_DB_URL" -c 'CREATE EXTENSION IF NOT EXISTS btree_gist' >/dev/null
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
age -d -i "$AGE_IDENTITY_FILE" -o "$tmp/industry.dump" "$archive"
pg_restore --list "$tmp/industry.dump" >/dev/null
pg_restore --exit-on-error --no-owner --no-acl --dbname="$DR_RESTORE_DB_URL" "$tmp/industry.dump"
psql -X -At --dbname="$DR_RESTORE_DB_URL" -c 'SELECT count(*) FROM industry.schema_migrations' >/dev/null
echo "Disaster-recovery restore verified in isolated database: $database"
