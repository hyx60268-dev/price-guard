$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogFile = Join-Path $ProjectRoot 'login-sync.log'

Set-Location $ProjectRoot
Start-Transcript -Path $LogFile -Append | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Wait-For-Exit {
    Write-Host ''
    Read-Host 'Press Enter to close this window'
}

function Refresh-ToolPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user;$env:ProgramFiles\nodejs;$env:ProgramFiles\GitHub CLI"
    $portableGh = Get-ChildItem (Join-Path $ProjectRoot '.tools') -Filter gh.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($portableGh) {
        $env:Path = "$($portableGh.DirectoryName);$env:Path"
    }
}

function Install-PortableGitHubCli {
    $toolsDir = Join-Path $ProjectRoot '.tools'
    $zipFile = Join-Path $toolsDir 'gh-windows-amd64.zip'
    $extractDir = Join-Path $toolsDir 'gh'
    New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
    Write-Host 'Downloading the official portable GitHub CLI...' -ForegroundColor Cyan
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/cli/cli/releases/latest' -Headers @{ 'User-Agent' = 'price-guard-login-sync' }
    $asset = $release.assets | Where-Object { $_.name -match 'windows_amd64\.zip$' } | Select-Object -First 1
    if (-not $asset) { throw 'Could not find the official Windows AMD64 GitHub CLI package.' }
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipFile -UseBasicParsing
    if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
    Expand-Archive -Path $zipFile -DestinationPath $extractDir -Force
    Remove-Item $zipFile -Force -ErrorAction SilentlyContinue
    Refresh-ToolPath
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw 'The portable GitHub CLI was downloaded but gh.exe could not be started.'
    }
}

function Install-WithWinget([string]$Id, [string]$DisplayName) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        if ($Id -eq 'GitHub.cli') {
            Install-PortableGitHubCli
            return
        }
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
