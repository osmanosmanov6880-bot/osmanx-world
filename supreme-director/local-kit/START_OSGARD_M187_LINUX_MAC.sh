#!/bin/sh
set -eu
cd "$(dirname "$0")"
python3 -m osgard_m187 restore-plan
python3 -m osgard_m187 plan-waves
python3 -m osgard_m187 audit --run-tests
python3 -m osgard_m186 init
exec python3 -m osgard_m186 serve
