@echo off
:: Remove old task if exists
schtasks /delete /tn "ButtonAgent" /f >nul 2>&1

:: Detect node.exe path
for /f "delims=" %%i in ('where node.exe 2^>nul') do set NODE_PATH=%%i
if "%NODE_PATH%"=="" (
    echo ERROR: node.exe not found in PATH.
    pause
    exit /b 1
)

:: Use current script directory to find server.js
set SCRIPT_DIR=%~dp0
set SERVER_PATH=%SCRIPT_DIR%server.js

if not exist "%SERVER_PATH%" (
    echo ERROR: server.js not found at %SERVER_PATH%
    pause
    exit /b 1
)

:: Create task that runs at system startup (before user login)
:: /ru SYSTEM = runs as SYSTEM account (no login required)
schtasks /create /tn "ButtonAgent" /tr "\"%NODE_PATH%\" \"%SERVER_PATH%\"" /sc onstart /ru SYSTEM /rl highest /f

echo ButtonAgent registered as system startup task (runs before login).
echo   node: %NODE_PATH%
echo   script: %SERVER_PATH%
pause
