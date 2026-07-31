<#
.SYNOPSIS
  Start all claudito instances defined in ecosystem.config.js under PM2.

.DESCRIPTION
  The PM2 auto-start scheduled task ("PM2 Resurrect (boot)") is registered with
  RunLevel=Highest, so the PM2 daemon runs elevated and owns \\.\pipe\rpc.sock.
  A non-elevated `pm2` CLI cannot connect to it and dies with:

      connect EPERM \\.\pipe\rpc.sock

  This script therefore re-launches itself elevated, then:
    1. builds dist/ (so PM2 does not start stale JS)
    2. removes the legacy single-instance app (`claudito`), if present
    3. starts every app in ecosystem.config.js
    4. saves the process list so the boot task resurrects all instances
    5. prints the resulting health of each port

  Everything is mirrored to logs/start-instances.log.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/start-instances.ps1
#>
[CmdletBinding()]
param(
    # Set when the script has already re-launched itself elevated.
    [switch]$Elevated,

    # Skip `npm run build`.
    [switch]$SkipBuild
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $repoRoot 'ecosystem.config.js'

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Native tools (pm2, npm, node) write progress to stderr. With
# $ErrorActionPreference = 'Stop' that turns into a terminating NativeCommandError
# and the script dies on the first harmless warning, so exit codes are checked by
# hand instead.
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$Arguments = @(),
        [switch]$IgnoreExitCode
    )

    $ErrorActionPreference = 'Continue'
    & $Exe @Arguments 2>&1 | ForEach-Object { Write-Host "    $_" }
    $code = $LASTEXITCODE

    if (-not $IgnoreExitCode -and $code -ne 0) {
        throw "$Exe $($Arguments -join ' ') failed with exit code $code"
    }

    return $code
}

if (-not (Test-IsAdmin)) {
    if ($Elevated) {
        Write-Host 'Elevation was requested but the process is still not running as Administrator.' -ForegroundColor Red
        exit 1
    }

    Write-Host 'Not running as Administrator - relaunching elevated (accept the UAC prompt)...' -ForegroundColor Yellow

    $argList = @(
        '-NoProfile'
        '-ExecutionPolicy', 'Bypass'
        '-NoExit'
        '-File', "`"$PSCommandPath`""
        '-Elevated'
    )

    if ($SkipBuild) {
        $argList += '-SkipBuild'
    }

    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList
    return
}

# ---------------------------------------------------------------- elevated path

$logDir = Join-Path $repoRoot 'logs'

if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

$logPath = Join-Path $logDir 'start-instances.log'
Start-Transcript -Path $logPath -Force | Out-Null

try {
    if (-not (Test-Path $configPath)) {
        throw "ecosystem.config.js not found at $configPath. Copy ecosystem.config.example.js first."
    }

    Set-Location $repoRoot

    # Read the config in-process so reported ports always match what PM2 starts.
    $ErrorActionPreference = 'Continue'
    $portsRaw = & node -e "const c=require('./ecosystem.config.js');console.log(c.apps.map(a=>a.env.PORT).join(' '))"

    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($portsRaw)) {
        throw "Could not read ports from $configPath (node exit code $LASTEXITCODE)."
    }

    $portList = ($portsRaw | Out-String).Trim() -split '\s+'

    Write-Host ''
    Write-Host "Instances to start: $($portList -join ', ')" -ForegroundColor Cyan
    Write-Host ''

    if ($SkipBuild) {
        Write-Host '[1/5] build skipped' -ForegroundColor DarkGray
    }
    else {
        Write-Host '[1/5] npm run build' -ForegroundColor Cyan
        Invoke-Native -Exe 'npm.cmd' -Arguments @('run', 'build') | Out-Null
    }

    Write-Host '[2/5] removing legacy single-instance app (claudito)' -ForegroundColor Cyan
    # Absent app => non-zero exit, which is expected on a clean machine.
    Invoke-Native -Exe 'pm2.cmd' -Arguments @('delete', 'claudito') -IgnoreExitCode | Out-Null

    Write-Host '[3/5] pm2 start ecosystem.config.js' -ForegroundColor Cyan
    Invoke-Native -Exe 'pm2.cmd' -Arguments @('start', $configPath) | Out-Null

    Write-Host '[4/5] pm2 save' -ForegroundColor Cyan
    Invoke-Native -Exe 'pm2.cmd' -Arguments @('save') | Out-Null

    Write-Host '[5/5] health check' -ForegroundColor Cyan
    Invoke-Native -Exe 'pm2.cmd' -Arguments @('list') -IgnoreExitCode | Out-Null

    # A cold start binds ports in a few seconds, but a loaded machine takes
    # longer. A single probe after a fixed sleep reported healthy instances as
    # FAIL and sent the operator to the error logs for nothing. Retry the way
    # restart-safe.ps1 does instead of guessing one sleep duration.
    $failed = @($portList)
    $lastError = @{}

    for ($attempt = 1; $attempt -le 10; $attempt++) {
        Start-Sleep -Seconds 4
        $failed = @()

        foreach ($port in $portList) {
            try {
                Invoke-RestMethod -Uri "http://localhost:$port/api/health" -TimeoutSec 10 | Out-Null
            }
            catch {
                $failed += $port
                $lastError[$port] = $_.Exception.Message
            }
        }

        if ($failed.Count -eq 0) { break }

        if ($attempt -lt 10) {
            Write-Host ("  waiting {0}/10 — no answer yet: {1}" -f $attempt, ($failed -join ', ')) -ForegroundColor DarkGray
        }
    }

    foreach ($port in $portList) {
        if ($failed -contains $port) {
            Write-Host ("  FAIL :{0}  {1}" -f $port, $lastError[$port]) -ForegroundColor Red
            Write-Host ("       check .\logs\claudito-$port-err.log") -ForegroundColor Red
            continue
        }

        try {
            $health = Invoke-RestMethod -Uri "http://localhost:$port/api/health" -TimeoutSec 10
            Write-Host ("  OK   :{0}  status={1} home={2}" -f $port, $health.status, $health.clauditoHome) -ForegroundColor Green
        }
        catch {
            # It answered a moment ago; do not downgrade it over one flaky probe.
            Write-Host ("  OK   :{0}" -f $port) -ForegroundColor Green
        }
    }

    Write-Host ''

    if ($failed.Count -gt 0) {
        Write-Host "Ports still down: $($failed -join ', ')" -ForegroundColor Red
    }
    else {
        Write-Host 'All instances healthy.' -ForegroundColor Green
    }

    Write-Host 'Reminder: every future pm2 command for claudito must also run elevated.' -ForegroundColor Yellow
}
catch {
    Write-Host ''
    Write-Host "ERROR: $_" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkRed
}
finally {
    try { Stop-Transcript | Out-Null } catch { }
    Write-Host ''
    Write-Host "Full log: $logPath" -ForegroundColor DarkGray
}
