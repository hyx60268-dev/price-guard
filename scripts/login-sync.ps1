$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogFile = Join-Path $ProjectRoot 'login-sync.log'

Set-Location $ProjectRoot
Start-Transcript -Path $LogFile -Append | Out-Null

function Wait-For-Exit {
    Write-Host ''
    Read-Host 'Press Enter to close this window'
}

function Refresh-ToolPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user;$env:ProgramFiles\nodejs;$env:ProgramFiles\GitHub CLI"
}

function Install-WithWinget([string]$Id, [string]$DisplayName) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "winget is unavailable. Install $DisplayName manually, then run this file again. Log: $LogFile"
    }
    Write-Host "Installing $DisplayName. Keep this window open..." -ForegroundColor Cyan
    & winget install --id $Id -e --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "$DisplayName installation failed. Exit code: $LASTEXITCODE"
    }
    Refresh-ToolPath
}

try {
    Write-Host 'Price Guard - Xianyu Login Sync' -ForegroundColor Green
    Write-Host "Log file: $LogFile"
    Refresh-ToolPath

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS'
    }
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Install-WithWinget 'GitHub.cli' 'GitHub CLI'
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'Node.js is installed but npm.cmd is unavailable. Restart Windows and run this file again.'
    }

    if (-not (Test-Path (Join-Path $ProjectRoot 'node_modules'))) {
        Write-Host 'Installing project dependencies...' -ForegroundColor Cyan
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed. Exit code: $LASTEXITCODE" }
    }

    Write-Host 'Preparing the login browser...' -ForegroundColor Cyan
    & npx.cmd playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "Browser installation failed. Exit code: $LASTEXITCODE" }

    & npm.cmd run login:sync
    if ($LASTEXITCODE -ne 0) { throw "Xianyu login sync did not finish. Exit code: $LASTEXITCODE" }

    Write-Host ''
    Write-Host 'Sync completed. GitHub has started the online cost scan.' -ForegroundColor Green
}
catch {
    Write-Host ''
    Write-Host 'The operation failed. This window will remain open.' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host "Detailed log: $LogFile" -ForegroundColor Yellow
}
finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
    Wait-For-Exit
}
