# OSGARD M187 - historical 180 task source recovery

**This release is an executable local recovery kit, NOT the missing original M180 or M181 checkpoint.**

## Recovered and independently rechecked

- Unmodified original user-provided `originals/DIRECTOR_MASTER_180.md`, dated October 17, 2026, SHA-256 `71fdda8231e1cb627a36fa683eaab1c28e4bdff2da9c95e0e6f6df83624a4b6c`.
- Exact original 180 brief IDs, 6 teams x 30, 60 P0 / 90 P1 / 30 P2, 294 explicit dependency references.
- `recovery_m187/ORIGINAL_180_TASKS.json` - validated machine-readable extraction, no fabricated M181 acceptance or source mappings.
- `recovery_m187/M187_DEPENDENCY_WAVES.json` - four topological waves; this order does not grant execution permission or prove any live product.
- Executable, previously recovered M186 local Director Studio and nine-stage **synthetic reference-only** integration lab.
- `osgard_m187` - SHA-pinned source parser, archive CRC/path/SHA inspection, local Git bundle inspection, positive and fail-closed tests.
- `recovery_m187/M187_RECOVERY_REPORT.json` - evidence of *local* verification.

## How to start

**Windows:** Install Python 3 and the dependency listed in `requirements-m185.txt`. Double click `START_OSGARD_M187_WINDOWS.cmd`.

**Linux/macOS:** Install Python 3, run `python3 -m pip install -r requirements-m185.txt` if needed, then `./START_OSGARD_M187_LINUX_MAC.sh`.

The script checks source, executes tests, prepares the private local database and starts the loopback-only application at `http://127.0.0.1:8765/`. The token is printed locally in the terminal. No keys or account data are bundled. Never make the service public.

For a narrower inspection without launching the UI:

```sh
python3 -m osgard_m187 restore-plan
python3 -m osgard_m187 plan-waves
python3 -m osgard_m187 audit --run-tests
```

If the original M180 and M181 archives later become available locally:

```sh
python3 -m osgard_m187 audit --m180 /path/to/M180.zip --m181 /path/to/M181.zip --run-tests
```

For M181, the recovery tool requires the recorded original whole-file SHA-256 before reading any archive members. M180 requires an external original whole-file pin before claiming its canonical origin; the CLI currently labels an unpinned M180 archive as **CRC_PASS_UNPINNED**, not as original source.

## Product release gates (not met)

- Original M180 Git commit `e8f88465d98c966bd6931883cc5c873b9fcd94a1`: not found in available M186 Git bundle.
- Original M181 Git commit `ff5e6de7e9614add995d11a7330fc2f13d2c1206`: not found in available M186 Git bundle.
- Original M181 ZIP SHA-256 `c6d0ff3ff9caa435e6928244ab70ecee8156747306ac3174faca82702be2969a`: source bytes not available in this kit.
- Canonical upstream approval 0/6; live product contracts 0/9; independent original task acceptance 0/180.
- There is no live integration, payment, external model call, production or deployment authorization.

The R135 Godot project with a separately reported lost 503MB source ZIP is **not** a member of this M187 Director recovery kit. The two project families are not mixed.
