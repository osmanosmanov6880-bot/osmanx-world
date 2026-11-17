#!/bin/sh
# Encrypted PostgreSQL schema backup with TWO independent age recipients.
set -eu
umask 077
test -n "$BACKUP_DB_URL"
test -n "$AGE_RECIPIENT_1"
test -n "$AGE_RECIPIENT_2"
test "$AGE_RECIPIENT_1" != "$AGE_RECIPIENT_2" || { echo 'Independent recipients required' >&2; exit 1; }
dest="$1"
test -n "$dest"
mkdir -p "$dest"
test -d "$dest"
dest=$(cd "$dest" && pwd -P)
temp_dir=$(mktemp -d "$dest/.industry-backup-XXXXXX")
trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM
name="industry-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump.age"
pg_dump --dbname="$BACKUP_DB_URL" --schema=industry --format=custom --no-owner --no-acl --file="$temp_dir/db.dump"
pg_restore --list "$temp_dir/db.dump" >/dev/null
age -r "$AGE_RECIPIENT_1" -r "$AGE_RECIPIENT_2" -o "$temp_dir/$name" "$temp_dir/db.dump"
cd "$temp_dir"
sha256sum "$name" > "$name.sha256"
mv "$name" "$dest/$name"
mv "$name.sha256" "$dest/$name.sha256"
echo "Encrypted backup created: $dest/$name"
echo 'Archive never stored unencrypted outside the temporary directory.'
