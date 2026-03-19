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

echo Starting Claude-to-IM bridge...
bash "scripts/daemon.sh" start

endlocal
