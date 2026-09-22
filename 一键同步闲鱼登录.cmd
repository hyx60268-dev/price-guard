@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，正在为你自动安装官方长期支持版……
  where winget >nul 2>nul
  if errorlevel 1 (
    echo.
    echo 这台电脑没有 winget，无法自动安装。
    echo 请打开 https://nodejs.org/zh-cn/download 下载 Windows 安装程序，安装后重新双击本文件。
    start "" "https://nodejs.org/zh-cn/download"
    pause
    exit /b 1
  )
  winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo Node.js 安装失败，请查看上方错误信息。
    pause
    exit /b 1
  )
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)

where gh >nul 2>nul
if errorlevel 1 (
  echo 未检测到 GitHub CLI，正在自动安装……
  winget install --id GitHub.cli -e --source winget --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo GitHub CLI 安装失败，请查看上方错误信息。
    pause
    exit /b 1
  )
  set "PATH=%PATH%;%ProgramFiles%\GitHub CLI"
)

if not exist node_modules call npm ci
call npx playwright install chromium
call npm run login:sync
pause
