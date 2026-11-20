@echo off
setlocal
cd /d "%~dp0"
if not exist "runtime\evidence" mkdir "runtime\evidence"
py -3.13 -c "import cryptography" >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python 3.13 and pinned cryptography are required.
  echo Install: py -3.13 -m pip install -r requirements-m185.txt
  pause
  exit /b 3
)
if not exist "runtime\m185_local.sqlite3" (
  py -3.13 -m osgard_m185 init-review --db "runtime\m185_local.sqlite3" --root "runtime\evidence" --trust "templates\TRUSTED_REVIEWERS_EMPTY.json"
  if errorlevel 1 (echo Initial review state failed. No server started. & pause & exit /b 3)
)
py -3.13 -m osgard_m185 doctor --db "runtime\m185_local.sqlite3" --root "runtime\evidence"
if errorlevel 1 (echo Integrity failed. No server started. & pause & exit /b 3)
py -3.13 -m osgard_m185 serve --db "runtime\m185_local.sqlite3" --root "runtime\evidence" --port 8765
if errorlevel 1 pause
