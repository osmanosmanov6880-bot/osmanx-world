#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p runtime
python3 -m osgard_m184 bootstrap --db runtime/m184_local.sqlite3 \
  --plan docs/M182_WORKPLAN_180_PROPOSED.json \
  --conflicts templates/CONFLICTS_PROVISIONAL.json \
  --contracts templates/CONTRACTS_PROVISIONAL.json \
  --observations docs/m183/CURRENT_GITHUB_DEFAULT_BRANCH_OBSERVATIONS_2026-10-27.json
printf '\nOpen http://127.0.0.1:8765/ and enter the session token shown below.\n'
python3 -m osgard_m184 serve --db runtime/m184_local.sqlite3 --port 8765
