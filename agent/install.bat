@echo off
schtasks /create /tn "ButtonAgent" /tr "\"C:\Program Files\nodejs\node.exe\" D:\projects\button\agent\server.js" /sc onlogon /rl highest /f
echo ButtonAgent registered as startup task.
pause
