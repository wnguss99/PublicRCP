# claudito 안전 재시작 래퍼
# --------------------------------------------------------------------------
# 검증 게이트(scripts/validate.mjs)를 통과한 경우에만 pm2 restart 한다.
# 검증 실패 시 재시작을 중단하므로, 깨진 코드로 서버가 떠서 시스템을
# 사용하지 못하게 되는 사고(2026-06-02)를 원천 차단한다.
#
# 사용:
#   powershell -ExecutionPolicy Bypass -File scripts/restart-safe.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/restart-safe.ps1 -Static   # 스모크 생략(빠름)
param([switch]$Static)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    Write-Host "=== claudito safe restart ===" -ForegroundColor Cyan

    Write-Host "1) Running validation gate..." -ForegroundColor Cyan
    if ($Static) { node scripts/validate.mjs --static }
    else { node scripts/validate.mjs }

    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "Validation FAILED - restart aborted. Existing server kept running." -ForegroundColor Red
        exit 1
    }

    Write-Host ""
    Write-Host "2) Validation passed -> pm2 restart claudito" -ForegroundColor Green
    pm2 restart claudito --update-env
    Start-Sleep -Seconds 3

    Write-Host "3) Health re-check (http://127.0.0.1:4000/login)" -ForegroundColor Cyan
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:4000/login" -UseBasicParsing -TimeoutSec 8
        Write-Host "   HTTP $($r.StatusCode) - restart OK." -ForegroundColor Green
    } catch {
        Write-Host "   WARN: no response on 4000 after restart - check 'pm2 logs claudito'." -ForegroundColor Yellow
        pm2 list
        exit 1
    }
    pm2 list
}
finally {
    Pop-Location
}
