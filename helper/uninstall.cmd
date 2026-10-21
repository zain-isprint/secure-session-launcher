@echo off
:: Removes Secure Session Helper for this Windows user.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
pause
