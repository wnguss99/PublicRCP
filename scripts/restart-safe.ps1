# claudito 안전 재시작 래퍼 (멀티 인스턴스)
# --------------------------------------------------------------------------
# 검증 게이트(scripts/validate.mjs)를 통과한 경우에만 재시작한다.
# 검증 실패 시 재시작을 중단하므로, 깨진 코드로 서버가 떠서 시스템을
# 사용하지 못하게 되는 사고(2026-06-02)를 원천 차단한다.
#
# 2026-07-30 갱신: 단일 앱 'claudito' → 포트별 인스턴스(claudito-4000/4001/4002).
# pm2 는 반드시 scripts/pm2.ps1 경유로 호출한다. PM2 데몬이 관리자 권한으로
# 돌기 때문에 일반 권한 pm2 는 `connect EPERM \\.\pipe\rpc.sock` 로 죽는다.
#
# 사용:
#   powershell -ExecutionPolicy Bypass -File scripts/restart-safe.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/restart-safe.ps1 -Static        # 스모크 생략(빠름)
#   powershell -ExecutionPolicy Bypass -File scripts/restart-safe.ps1 -Port 4001     # 한 인스턴스만
param(
    [switch]$Static,
    [string]$Port
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'ecosystem.config.js'
$pm2Wrapper = Join-Path $root 'scripts\pm2.ps1'

function Invoke-Pm2 {
    param([string[]]$Pm2Args)

    $ErrorActionPreference = 'Continue'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $pm2Wrapper @Pm2Args
    return $LASTEXITCODE
}

Push-Location $root
try {
    Write-Host "=== claudito safe restart (multi-instance) ===" -ForegroundColor Cyan

    if (-not (Test-Path $configPath)) {
        Write-Host "ecosystem.config.js 없음 - 재시작 중단." -ForegroundColor Red
        exit 1
    }

    Write-Host "1) Running validation gate..." -ForegroundColor Cyan
    $ErrorActionPreference = 'Continue'
    if ($Static) { node scripts/validate.mjs --static }
    else { node scripts/validate.mjs }

    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "Validation FAILED - restart aborted. Existing instances kept running." -ForegroundColor Red
        exit 1
    }
    $ErrorActionPreference = 'Stop'

    # 대상 포트 결정: -Port 로 하나만, 아니면 ecosystem 전체.
    if ($Port) {
        $ports = @($Port)
    }
    else {
        $ErrorActionPreference = 'Continue'
        $raw = & node -e "const c=require('./ecosystem.config.js');console.log(c.apps.map(a=>a.env.PORT).join(' '))"
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
            Write-Host "ecosystem.config.js 에서 포트를 읽지 못했다 - 재시작 중단." -ForegroundColor Red
            exit 1
        }
        $ports = ($raw | Out-String).Trim() -split '\s+'
        $ErrorActionPreference = 'Stop'
    }

    Write-Host ""
    Write-Host "2) Validation passed -> restarting: $($ports -join ', ')" -ForegroundColor Green

    foreach ($p in $ports) {
        Invoke-Pm2 @('restart', "claudito-$p", '--update-env') | Out-Null
    }

    Start-Sleep -Seconds 6

    Write-Host "3) Health re-check" -ForegroundColor Cyan
    $failed = @()

    foreach ($p in $ports) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/api/health" -UseBasicParsing -TimeoutSec 8
            Write-Host "   :$p HTTP $($r.StatusCode) - OK" -ForegroundColor Green
        }
        catch {
            $failed += $p
            Write-Host "   :$p NO RESPONSE - check logs\claudito-$p-err.log" -ForegroundColor Red
        }
    }

    Invoke-Pm2 @('list') | Out-Null

    if ($failed.Count -gt 0) {
        Write-Host ""
        Write-Host "재시작 후에도 응답 없는 포트: $($failed -join ', ')" -ForegroundColor Red
        exit 1
    }
}
finally {
    Pop-Location
}
