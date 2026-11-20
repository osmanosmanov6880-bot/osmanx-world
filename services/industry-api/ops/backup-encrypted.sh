#!/bin/sh
# R42: strictly local, explicitly acknowledged synthetic encrypted backup.
# Refuse arbitrary/relative/shared destinations and never overwrite artifacts.
set -eu
umask 077
test "$#" -eq 1 || { echo "One absolute owner-only backup directory required" >&2; exit 2; }
dest="$1"
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
node "$root/scripts/r42-backup-preflight.mjs" "$dest" >/dev/null ||
 { echo 'R42 private backup destination/source refused' >&2; exit 2; }
temp_dir=$(mktemp -d "$dest/.industry-backup-XXXXXX")
trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM
name="industry-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump.age"
pg_dump --dbname="$BACKUP_DB_URL" --schema=industry --format=custom \
  --no-owner --no-acl --file="$temp_dir/db.dump"
pg_restore --list "$temp_dir/db.dump" >/dev/null
age -r "$AGE_RECIPIENT_1" -r "$AGE_RECIPIENT_2" -o "$temp_dir/$name" "$temp_dir/db.dump"
(
  cd "$temp_dir"
  sha256sum "$name" > "$name.sha256"
)
# Hardlink creation on same private filesystem is atomic and refuses existing
# paths (no mv-overwrite window). On failed second link, remove first link.
ln "$temp_dir/$name" "$dest/$name" ||
 { echo 'R42 archive already exists or destination changed' >&2; exit 2; }
if ! ln "$temp_dir/$name.sha256" "$dest/$name.sha256"; then
  rm -f -- "$dest/$name"
  echo 'R42 manifest collision: refusing partial backup' >&2
  exit 2
fi
echo "Encrypted local synthetic backup created: $name"
echo 'Two AGE recipients; external custody/production recovery NOT verified.'
