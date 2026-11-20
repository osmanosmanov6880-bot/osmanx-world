#!/bin/sh
set -eu
cd "$(dirname "$0")"
python3 -m osgard_m186 init
exec python3 -m osgard_m186 serve
