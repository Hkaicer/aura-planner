@echo off
rem AURA launcher: checks Node.js, installs dependencies the first time,
rem builds the interface, starts the local server and opens AURA.
rem Close this window (or press Ctrl+C) to stop AURA.
setlocal EnableExtensions
cd /d "%~dp0"
title AURA

set "AURA_PORT_VALUE=4317"
set "AURA_OPEN_VALUE=browser"
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="AURA_PORT" set "AURA_PORT_VALUE=%%b"
    if /i "%%a"=="AURA_OPEN" set "AURA_OPEN_VALUE=%%b"
  )
)
set "AURA_URL=http://127.0.0.1:%AURA_PORT_VALUE%"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed. Install Node.js 22.13 or newer from https://nodejs.org
  echo  then run this file again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -v') do set "NODE_MAJOR=%%v"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if %NODE_MAJOR% LSS 22 (
  echo.
  echo  AURA needs Node.js 22.13 or newer ^(found %NODE_MAJOR%^). Update it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

rem Already running? Just open it.
curl -s -o nul -m 2 "%AURA_URL%/api/health" >nul 2>nul
if not errorlevel 1 (
  echo AURA is already running at %AURA_URL%
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-aura.ps1" -Url "%AURA_URL%" -Mode "%AURA_OPEN_VALUE%" -NoWait
  exit /b 0
)

if not exist "node_modules" (
  echo Installing dependencies ^(first launch only^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :failed
)

echo Building the interface...
call npm run build --silent
if errorlevel 1 goto :failed

if /i not "%AURA_OPEN_VALUE%"=="none" (
  start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-aura.ps1" -Url "%AURA_URL%" -Mode "%AURA_OPEN_VALUE%"
)

echo.
echo  AURA is starting at %AURA_URL%  ^(this computer only^)
echo  Keep this window open while you use AURA. Close it to stop.
echo.
call npm start
exit /b %errorlevel%

:failed
echo.
echo  AURA could not start. See the messages above, or the Troubleshooting section of README.md.
echo.
pause
exit /b 1
