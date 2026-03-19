@echo off
setlocal

cd /d "%~dp0"

echo Stopping Claude-to-IM bridge...
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 stop

echo Waiting 5 seconds...
timeout /t 5 /nobreak >nul

echo Starting Claude-to-IM bridge...
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 start

echo Current status:
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 status

endlocal
