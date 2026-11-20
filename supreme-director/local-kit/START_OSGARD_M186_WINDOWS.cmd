@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>&1
if errorlevel 1 (
  echo Python launcher is required. Install Python 3.13 and run again.
  pause
  exit /b 1
)
py -3.13 -m osgard_m186 init
if errorlevel 1 (
  echo Initialization refused. Read docs\m186\OPERATOR_RUNBOOK_RU.md
  pause
  exit /b 1
)
py -3.13 -m osgard_m186 serve
pause
