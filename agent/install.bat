@echo off
:: Remove old logon-based task if exists
schtasks /delete /tn "ButtonAgent" /f >nul 2>&1

:: Create task that runs at system startup (before user login)
:: /ru SYSTEM = runs as SYSTEM account (no login required)
schtasks /create /tn "ButtonAgent" /tr "\"C:\Program Files\nodejs\node.exe\" D:\projects\button\agent\server.js" /sc onstart /ru SYSTEM /rl highest /f

echo ButtonAgent registered as system startup task (runs before login).
pause
