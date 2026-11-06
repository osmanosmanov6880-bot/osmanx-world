@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo Python 3.13 launcher not found. Install Python 3.13 and retry.
  pause
  exit /b 1
)
if not exist "runtime" mkdir "runtime"
py -3 -m osgard_m184 bootstrap --db runtime\m184_local.sqlite3 --plan docs\M182_WORKPLAN_180_PROPOSED.json --conflicts templates\CONFLICTS_PROVISIONAL.json --contracts templates\CONTRACTS_PROVISIONAL.json --observations docs\m183\CURRENT_GITHUB_DEFAULT_BRANCH_OBSERVATIONS_2026-10-27.json
if errorlevel 1 (
  echo SAFE STOP: Local source inputs or database did not pass verification.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:8765/ in your browser after the token is printed.
echo The private token is shown below; paste it into the local login dialog.
py -3 -m osgard_m184 serve --db runtime\m184_local.sqlite3 --port 8765
pause
