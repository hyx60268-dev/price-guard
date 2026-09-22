@echo off
cd /d "%~dp0"
powershell.exe -NoLogo -NoExit -ExecutionPolicy Bypass -File "%~dp0scripts\login-sync.ps1"
echo.
echo PowerShell could not start. Please send login-sync.log to support.
pause
