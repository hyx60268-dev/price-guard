$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogFile = Join-Path $ProjectRoot 'login-sync.log'

Set-Location $ProjectRoot
Start-Transcript -Path $LogFile -Append | Out-Null

function Wait-For-Exit {
    Write-Host ''
    Read-Host '按回车键关闭窗口'
}

function Refresh-ToolPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user;$env:ProgramFiles\nodejs;$env:ProgramFiles\GitHub CLI"
}

function Install-WithWinget([string]$Id, [string]$DisplayName) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "系统没有 winget，无法自动安装 $DisplayName。请把 $LogFile 发给维护人员。"
    }
    Write-Host "正在安装 $DisplayName，请不要关闭窗口……" -ForegroundColor Cyan
    & winget install --id $Id -e --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "$DisplayName 安装失败，退出代码：$LASTEXITCODE"
    }
    Refresh-ToolPath
}

try {
    Write-Host '价格守卫：闲鱼登录同步' -ForegroundColor Green
    Write-Host "运行日志：$LogFile"
    Refresh-ToolPath

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js 长期支持版'
    }
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Install-WithWinget 'GitHub.cli' 'GitHub CLI'
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'Node.js 已安装，但当前窗口仍找不到 npm.cmd。请重新启动电脑后再次运行本文件。'
    }

    if (-not (Test-Path (Join-Path $ProjectRoot 'node_modules'))) {
        Write-Host '正在安装项目依赖……' -ForegroundColor Cyan
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci 执行失败，退出代码：$LASTEXITCODE" }
    }

    Write-Host '正在准备登录浏览器……' -ForegroundColor Cyan
    & npx.cmd playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "浏览器安装失败，退出代码：$LASTEXITCODE" }

    & npm.cmd run login:sync
    if ($LASTEXITCODE -ne 0) { throw "闲鱼登录同步未完成，退出代码：$LASTEXITCODE" }

    Write-Host ''
    Write-Host '同步成功。GitHub 已开始线上成本扫描。' -ForegroundColor Green
}
catch {
    Write-Host ''
    Write-Host '执行失败，窗口不会关闭。' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host "详细日志保存在：$LogFile" -ForegroundColor Yellow
}
finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
    Wait-For-Exit
}
