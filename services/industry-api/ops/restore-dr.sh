#!/bin/sh
# R39: local DISPOSABLE PostgreSQL restore only. No production path.
# Safeguards are enforced here even if R36/R37 operator wrappers are bypassed.
set -eu
umask 077
: "${DR_RESTORE_DB_URL:?DR target URL required}"
: "${AGE_IDENTITY_FILE:?AGE identity required}"
test "$#" -eq 1 || { echo 'Exactly one AGE archive required' >&2; exit 2; }
archive="$1"
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
test -f "$archive" && test ! -L "$archive" ||
 { echo 'Refusing symlink or missing AGE archive' >&2; exit 2; }
test -f "$archive.sha256" && test ! -L "$archive.sha256" ||
 { echo 'Refusing symlink or missing archive digest' >&2; exit 2; }
test -f "$AGE_IDENTITY_FILE" && test ! -L "$AGE_IDENTITY_FILE" ||
 { echo 'Refusing symlink or missing AGE identity' >&2; exit 2; }

# Mandatory local + genuinely empty database check before any decryption.
node "$root/scripts/r39-dr-preflight.mjs" >/dev/null ||
 { echo 'Refusing unsafe target before decryption' >&2; exit 2; }
name=$(basename -- "$archive")
archive_dir=$(dirname -- "$archive")
(
 cd "$archive_dir"
 sha256sum -c "$name.sha256" >/dev/null
)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
age -d -i "$AGE_IDENTITY_FILE" -o "$tmp/industry.dump" "$archive"
pg_restore --list "$tmp/industry.dump" >/dev/null

# Repeat immediately before DDL; detect unexpected connections/relations.
node "$root/scripts/r39-dr-preflight.mjs" >/dev/null ||
 { echo 'Refusing target changed during decryption' >&2; exit 2; }
database=$(psql -X -v ON_ERROR_STOP=1 -At --dbname="$DR_RESTORE_DB_URL" \
  -c 'SELECT current_database()')
case "$database" in
  industry_dr_*) ;;
  *) echo 'Refusing unexpected target DB name' >&2; exit 2 ;;
esac
psql -X -v ON_ERROR_STOP=1 --dbname="$DR_RESTORE_DB_URL" \
  -c 'CREATE EXTENSION IF NOT EXISTS btree_gist' >/dev/null
# No parallel workers. PostgreSQL rollback on any SQL restore failure.
pg_restore --single-transaction --exit-on-error --no-owner --no-acl \
  --dbname="$DR_RESTORE_DB_URL" "$tmp/industry.dump"
count=$(psql -X -v ON_ERROR_STOP=1 -At --dbname="$DR_RESTORE_DB_URL" \
  -c 'SELECT count(*) FROM industry.schema_migrations')
case "$count" in
  ''|*[!0-9]*) echo 'Restore migration count invalid' >&2; exit 1 ;;
  *) test "$count" -ge 11 || { echo 'Incomplete migrations after restore' >&2; exit 1; } ;;
esac
echo "Disaster-recovery restore verified in isolated database: $database"
