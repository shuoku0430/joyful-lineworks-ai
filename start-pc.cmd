@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 LTS, then run this file again.
  pause
  exit /b 1
)
if not exist node_modules\jose\package.json (
  call npm ci
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
start "" "http://127.0.0.1:8787"
call npm run pc
pause
