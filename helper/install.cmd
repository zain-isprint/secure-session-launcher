@echo off
:: Installs Secure Session Helper for this Windows user (no administrator rights needed).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
