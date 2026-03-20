@echo off
setlocal

cd /d "%~dp0"

echo Stopping Claude-to-IM bridge...
bash "scripts/daemon.sh" stop
echo Waiting 3 seconds...
timeout /t 3 /nobreak >nul

echo Current status:
bash "scripts/daemon.sh" status

echo Waiting 3 seconds...
timeout /t 3 /nobreak >nul

echo Building bridge and daemon...
call npm run build
if errorlevel 1 goto :build_failed

echo Starting Claude-to-IM bridge...
bash "scripts/daemon.sh" start

endlocal
goto :eof

:build_failed
echo Build failed. Bridge was not restarted.
endlocal
exit /b 1
