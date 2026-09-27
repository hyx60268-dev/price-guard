@echo off
setlocal
cd /d "%~dp0"

set "SYNC_PS1=%~dp0scripts\login-sync.ps1"

rem Windows may extract only this .cmd when it is opened directly inside a ZIP.
rem In that case, download the complete current project to a stable local folder.
if exist "%SYNC_PS1%" goto run_sync

echo This copy is incomplete because it was opened inside a ZIP file.
echo Downloading the complete current Price Guard login tool...
set "PG_BOOTSTRAP_ROOT=%LOCALAPPDATA%\PriceGuard"
set "PG_BOOTSTRAP_ZIP=%TEMP%\price-guard-main.zip"
set "PG_BOOTSTRAP_EXTRACT=%TEMP%\price-guard-bootstrap"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $root=$env:PG_BOOTSTRAP_ROOT; $zip=$env:PG_BOOTSTRAP_ZIP; $extract=$env:PG_BOOTSTRAP_EXTRACT; $target=Join-Path $root 'price-guard-main'; Remove-Item $zip -Force -ErrorAction SilentlyContinue; Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force -Path $root ^| Out-Null; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/hyx60268-dev/price-guard/archive/refs/heads/main.zip' -OutFile $zip; Expand-Archive -Path $zip -DestinationPath $extract -Force; if (Test-Path $target) { Remove-Item $target -Recurse -Force }; Move-Item (Join-Path $extract 'price-guard-main') $target; Remove-Item $zip -Force -ErrorAction SilentlyContinue; Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue"
if errorlevel 1 goto bootstrap_failed

set "SYNC_PS1=%PG_BOOTSTRAP_ROOT%\price-guard-main\scripts\login-sync.ps1"
if not exist "%SYNC_PS1%" goto bootstrap_failed

:run_sync
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SYNC_PS1%"
if not errorlevel 1 goto done

echo.
echo PowerShell could not start. Please send login-sync.log to support.
pause
exit /b 1

:bootstrap_failed
echo.
echo The complete login tool could not be downloaded.
echo Please right-click the ZIP file, choose Extract All, and run this file again.
pause
exit /b 1

:done
endlocal
