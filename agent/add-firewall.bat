@echo off
set /p AGENT_PORT="Agent port [9876]: " || set AGENT_PORT=9876
if "%AGENT_PORT%"=="" set AGENT_PORT=9876
netsh advfirewall firewall add rule name="Button Agent TCP %AGENT_PORT%" dir=in action=allow protocol=TCP localport=%AGENT_PORT%
echo Firewall rule added for port %AGENT_PORT%.
