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

:: Create task that runs at user logon (interactive session, can open GUI apps)
:: /ru with current user = runs in user session (can open VS Code, psmux visible)
schtasks /create /tn "ButtonAgent" /tr "\"%NODE_PATH%\" \"%SERVER_PATH%\"" /sc onlogon /ru "%USERNAME%" /rl highest /f

echo ButtonAgent registered as logon startup task (runs in user session).
echo   node: %NODE_PATH%
echo   script: %SERVER_PATH%
pause
