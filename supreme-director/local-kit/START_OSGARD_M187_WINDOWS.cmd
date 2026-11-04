@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  set "PY=py -3"
) else (
  set "PY=python"
)
echo OSGARD M187 - historical 180 task restoration / local only
%PY% -m osgard_m187 restore-plan || goto :failed
%PY% -m osgard_m187 plan-waves || goto :failed
%PY% -m osgard_m187 audit --run-tests || goto :failed
%PY% -m osgard_m186 init || goto :failed
%PY% -m osgard_m186 serve
exit /b %errorlevel%
:failed
echo M187 local verification failed; production remains NO-GO.
pause
exit /b 1
