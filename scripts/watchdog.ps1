<#
.SYNOPSIS
  claudito 인스턴스 감시 + 자동 복구.

.DESCRIPTION
  2026-07-30 사고: pm2 CLI 가 EPERM 으로 죽어 3개 인스턴스가 전부 내려간 상태로
  방치됐고, 아무도 그걸 몰랐다. "죽은 걸 몰랐던 상태"를 없애는 것이 이 스크립트의
  목적이다.

  동작:
    1. ecosystem.config.js 에서 포트 목록을 읽는다
    2. 각 포트의 /api/health 를 확인한다
    3. 죽은 포트가 있으면 해당 인스턴스만 pm2 로 되살린다
       (pm2 에 등록조차 안 돼 있으면 ecosystem 전체를 start)
    4. 결과를 logs/watchdog.log 에 append 한다

  Task Scheduler 에 등록돼 5분마다 실행된다 (scripts/install-guards.ps1 참조).
  스케줄 작업이 RunLevel=Highest 로 돌기 때문에 pm2 데몬과 권한이 일치한다.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/watchdog.ps1
#>
[CmdletBinding()]
param(
    # 확인만 하고 복구는 하지 않는다.
    [switch]$CheckOnly
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $repoRoot 'ecosystem.config.js'
$logDir = Join-Path $repoRoot 'logs'
$logPath = Join-Path $logDir 'watchdog.log'

if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')

    $line = '{0} {1,-5} {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Host $line
    Add-Content -Path $logPath -Value $line -Encoding UTF8
}

function Get-InstancePorts {
    $ErrorActionPreference = 'Continue'
    $raw = & node -e "const c=require('$($configPath -replace '\\', '/')');console.log(c.apps.map(a=>a.env.PORT).join(' '))" 2>&1

    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
        Write-Log "ecosystem.config.js 를 읽을 수 없다: $raw" 'ERROR'
        return @()
    }

    return ($raw | Out-String).Trim() -split '\s+'
}

function Test-Instance {
    param([string]$Port)

    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 8
        return $r.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

# 포트가 살아 있어도 채팅이 전부 실패할 수 있다: ANTHROPIC_API_KEY 가 사용 불가한
# 값이면 Claude CLI 가 구독 대신 그걸 써서 "Invalid API key" 로 끝난다(2026-07-30).
# 헬스체크만 보면 초록불이라 아무도 모른 채 방치되므로 여기서 같이 감시한다.
function Test-AuthWarning {
    param([Parameter(Mandatory)][string[]]$Ports)

    foreach ($port in $Ports) {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 8

            if ($h.authWarning) {
                Write-Log "인증 경고 :$port → $($h.authWarning) — 채팅이 전부 실패한다. 'npm run validate:instances' 로 확인" 'ERROR'
            }
        }
        catch {
            # 헬스 자체가 실패하면 위의 다운 감지가 처리한다.
        }
    }
}

# PM2 로그는 무제한으로 커진다 (단일 인스턴스 시절 claudito-err.log 가 5MB 까지
# 자랐고, 이제 인스턴스가 3개다). PM2 가 파일 핸들을 잡고 있어 Windows 에서는
# rename 이 실패할 수 있으므로, 꼬리만 보관하고 `pm2 flush` 로 PM2 가 직접 비우게 한다.
function Invoke-LogRotation {
    param(
        [Parameter(Mandatory)][string[]]$Ports,
        [int]$MaxMB = 20,
        [int]$KeepLines = 2000,
        [int]$KeepDays = 14
    )

    # Only the files PM2 itself writes. `pm2 flush` is what actually empties them,
    # so touching any other file would archive it again on every run without ever
    # shrinking it — an endless 5-minute loop.
    $owned = foreach ($p in $Ports) { "claudito-$p-out.log"; "claudito-$p-err.log" }

    $big = @(Get-ChildItem -Path $logDir -Filter 'claudito-*.log' -ErrorAction SilentlyContinue |
        Where-Object { $owned -contains $_.Name -and $_.Length -gt ($MaxMB * 1MB) })

    if ($big.Count -eq 0) {
        return
    }

    $archiveDir = Join-Path $logDir 'archive'

    if (-not (Test-Path $archiveDir)) {
        New-Item -ItemType Directory -Path $archiveDir | Out-Null
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

    foreach ($f in $big) {
        $target = Join-Path $archiveDir ('{0}-{1}.log' -f $f.BaseName, $stamp)

        try {
            Get-Content -Path $f.FullName -Tail $KeepLines -ErrorAction Stop |
                Set-Content -Path $target -Encoding UTF8
            Write-Log ("로그 회전: {0} ({1:N1}MB) → {2}" -f $f.Name, ($f.Length / 1MB), (Split-Path $target -Leaf))
        }
        catch {
            Write-Log "로그 꼬리 보관 실패 ($($f.Name)): $_" 'WARN'
        }
    }

    $ErrorActionPreference = 'Continue'
    & pm2.cmd flush 2>&1 | ForEach-Object { Write-Log "  $_" }

    # If flush did not shrink them (non-elevated run => EPERM, or PM2 not managing
    # this file), say so instead of silently re-archiving forever.
    foreach ($f in $big) {
        $now = Get-Item $f.FullName -ErrorAction SilentlyContinue

        if ($null -ne $now -and $now.Length -gt ($MaxMB * 1MB)) {
            Write-Log ("pm2 flush 후에도 {0} 가 {1:N1}MB — 관리자 권한으로 실행됐는지 확인" -f $f.Name, ($now.Length / 1MB)) 'WARN'
        }
    }

    Get-ChildItem -Path $archiveDir -Filter '*.log' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
        ForEach-Object {
            Write-Log "오래된 아카이브 삭제: $($_.Name)"
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
        }
}

if (-not (Test-Path $configPath)) {
    Write-Log "ecosystem.config.js 없음 ($configPath) — 감시 대상 없음" 'ERROR'
    exit 1
}

Set-Location $repoRoot

$ports = Get-InstancePorts

if ($ports.Count -eq 0) {
    exit 1
}

if (-not $CheckOnly) {
    Invoke-LogRotation -Ports $ports
}

$down = @($ports | Where-Object { -not (Test-Instance $_) })

if ($down.Count -eq 0) {
    Test-AuthWarning -Ports $ports
    Write-Log "정상 — 포트 $($ports -join ', ') 전부 응답"
    exit 0
}

Write-Log "다운 감지: 포트 $($down -join ', ') (전체 $($ports -join ', '))" 'WARN'

if ($CheckOnly) {
    exit 1
}

$ErrorActionPreference = 'Continue'

# pm2 에 등록돼 있는지 확인. 목록 자체를 못 가져오면(데몬 죽음/권한 불일치)
# ecosystem 전체를 start 해서 데몬까지 다시 세운다.
$listRaw = & pm2.cmd jlist 2>&1
$known = @()

if ($LASTEXITCODE -eq 0) {
    try {
        $known = @(($listRaw | Out-String | ConvertFrom-Json) | ForEach-Object { $_.name })
    }
    catch {
        Write-Log "pm2 jlist 파싱 실패 — ecosystem 전체 start 로 진행" 'WARN'
    }
}
else {
    Write-Log "pm2 jlist 실패 (권한 불일치 또는 데몬 없음) — ecosystem 전체 start 로 진행" 'WARN'
}

$recovered = @()

foreach ($port in $down) {
    $name = "claudito-$port"

    if ($known -contains $name) {
        Write-Log "restart $name"
        & pm2.cmd restart $name --update-env 2>&1 | ForEach-Object { Write-Log "  $_" }
    }
    else {
        Write-Log "$name 이 pm2 에 없다 — ecosystem 전체 start"
        & pm2.cmd start $configPath 2>&1 | ForEach-Object { Write-Log "  $_" }
        # 전체 start 는 한 번만 하면 나머지 포트까지 같이 올라온다.
        $known = $ports | ForEach-Object { "claudito-$_" }
    }

    $recovered += $port
}

& pm2.cmd save 2>&1 | ForEach-Object { Write-Log "  $_" }

Start-Sleep -Seconds 10

$stillDown = @($recovered | Where-Object { -not (Test-Instance $_) })

if ($stillDown.Count -eq 0) {
    Write-Log "복구 완료 — 포트 $($recovered -join ', ')"
    exit 0
}

Write-Log "복구 실패 — 포트 $($stillDown -join ', ') 여전히 다운. logs\claudito-<port>-err.log 확인 필요" 'ERROR'
exit 1
