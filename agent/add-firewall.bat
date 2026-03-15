@echo off
netsh advfirewall firewall add rule name="Button Agent TCP 9876" dir=in action=allow protocol=TCP localport=9876
