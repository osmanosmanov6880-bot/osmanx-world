#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p runtime/evidence
chmod 700 runtime/evidence
if ! python3 -c 'import cryptography' 2>/dev/null; then
  echo 'Requires Python 3.13+ and cryptography. Run: python3 -m pip install -r requirements-m185.txt' >&2
  exit 3
fi
if [ ! -f runtime/m185_local.sqlite3 ]; then
  python3 -m osgard_m185 init-review --db runtime/m185_local.sqlite3 --root runtime/evidence --trust templates/TRUSTED_REVIEWERS_EMPTY.json
fi
python3 -m osgard_m185 doctor --db runtime/m185_local.sqlite3 --root runtime/evidence
exec python3 -m osgard_m185 serve --db runtime/m185_local.sqlite3 --root runtime/evidence --port 8765
