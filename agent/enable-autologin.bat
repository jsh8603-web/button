@echo off
:: Enable Windows auto-login (skip lock screen after WOL boot)
:: Must run as Administrator

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Run this script as Administrator.
    pause
    exit /b 1
)

set /p USERNAME="Microsoft account email: "
if "%USERNAME%"=="" (
    echo ERROR: Email is required.
    pause
    exit /b 1
)
set DEFAULT_DOMAIN=MicrosoftAccount
set /p PASSWORD="Microsoft account password (not PIN): "

reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon /t REG_SZ /d 1 /f
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultUserName /t REG_SZ /d "%USERNAME%" /f
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultPassword /t REG_SZ /d "%PASSWORD%" /f
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultDomainName /t REG_SZ /d "%DEFAULT_DOMAIN%" /f

:: Wait for network before logon (fixes MS account auth failure on boot)
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows NT\CurrentVersion\Winlogon" /v SyncForegroundPolicy /t REG_DWORD /d 1 /f

echo.
echo Auto-login enabled for %USERNAME% (domain: %DEFAULT_DOMAIN%).
echo Network wait policy enabled.
echo Reboot to verify.
pause
