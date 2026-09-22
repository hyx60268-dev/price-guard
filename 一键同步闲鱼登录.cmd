@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (
  echo 未检测到 Node.js，请先安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)
if not exist node_modules call npm ci
call npx playwright install chromium
call npm run login:sync
pause
