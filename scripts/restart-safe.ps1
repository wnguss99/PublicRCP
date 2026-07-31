# claudito 안전 재시작 래퍼 (멀티 인스턴스, 자동 롤백)
# --------------------------------------------------------------------------
# 검증 게이트(scripts/validate.mjs)를 통과한 경우에만 재시작한다.
# 검증 실패 시 재시작을 중단하므로, 깨진 코드로 서버가 떠서 시스템을
# 사용하지 못하게 되는 사고(2026-06-02)를 원천 차단한다.
#
# 2026-07-30: 단일 앱 'claudito' → 포트별 인스턴스(claudito-4000/4001/4002).
# pm2 는 반드시 scripts/pm2.ps1 경유로 호출한다. PM2 데몬이 관리자 권한으로
# 돌기 때문에 일반 권한 pm2 는 `connect EPERM \\.\pipe\rpc.sock` 로 죽는다.
#
# 2026-07-31: 자동 롤백 추가. 서버는 원격(재택/출장)에서만 쓰이므로, 재시작이
# 실패해 먹통이 되면 사무실에 물리적으로 가야 복구된다. 그 상황을 없애기 위해:
#
#   1. 재시작 전 "지금 정상 동작하는 dist" 를 .lkg/ 에 스냅샷한다
#   2. 검증 게이트 → 재시작 → 헬스체크
#   3. 하나라도 안 뜨면 스냅샷을 되돌리고 다시 재시작해 복구한다
#
# 사용:
#   powershell -ExecutionPolicy Bypass -File scripts/restart-safe.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/restart-safe.ps1 -Static     # 스모크 생략(빠름)
#   powershell -ExecutionPolicy Bypass -File scripts/restart-safe.ps1 -NoRollback # 롤백 끄기(디버깅용)
param(
    [switch]$Static,
    [string]$Port,
    [switch]$NoRollback
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'ecosystem.config.js'
$pm2Wrapper = Join-Path $root 'scripts\pm2.ps1'
$distPath = Join-Path $root 'dist'
$lkgPath = Join-Path $root '.lkg\dist'

function Invoke-Pm2 {
    param([string[]]$Pm2Args)

    $ErrorActionPreference = 'Continue'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $pm2Wrapper @Pm2Args
    return $LASTEXITCODE
}

function Get-TargetPorts {
    if ($Port) {
        return @($Port)
    }

    $ErrorActionPreference = 'Continue'
    $raw = & node -e "const c=require('./ecosystem.config.js');console.log(c.apps.map(a=>a.env.PORT).join(' '))"

    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
        throw 'ecosystem.config.js 에서 포트를 읽지 못했다.'
    }

    return ($raw | Out-String).Trim() -split '\s+'
}

# 기동에는 몇 초가 걸린다. 한 번 찔러보고 실패로 단정하면 멀쩡한 배포를 롤백한다.
function Wait-Healthy {
    param([string[]]$Ports, [int]$Attempts = 10, [int]$DelaySeconds = 3)

    for ($i = 1; $i -le $Attempts; $i++) {
        $bad = @()

        foreach ($p in $Ports) {
            try {
                $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/api/health" -UseBasicParsing -TimeoutSec 6
                if ($r.StatusCode -ne 200) { $bad += $p }
            }
            catch { $bad += $p }
        }

        if ($bad.Count -eq 0) {
            return @()
        }

        if ($i -lt $Attempts) {
            Start-Sleep -Seconds $DelaySeconds
        }
    }

    return $bad
}

# known-good 스냅샷은 반드시 "재시작해서 실제로 떠 있는 것을 확인한 dist" 여야 한다.
#
# 처음에는 재시작 *전* 에 찍었는데, 그러면 이런 함정에 빠진다: 직전 실행에서 검증
# 게이트가 실패해도 게이트 안의 `npm run build` 는 이미 dist 를 깨뜨려 놓는다.
# 그런데 인스턴스는 메모리에 이전 코드를 들고 계속 정상 응답하므로, 헬스체크만 보면
# "정상" 으로 보여 깨진 dist 를 known-good 으로 저장해 버린다. 실제로 롤백이
# 깨진 빌드를 복원해 세 포트가 모두 죽었다(2026-07-31 검증 중 재현).
#
# 프로세스가 건강한 것과 디스크의 dist 가 정상인 것은 별개다.
function Save-KnownGood {
    try {
        $parent = Split-Path $lkgPath -Parent
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        if (Test-Path $lkgPath) { Remove-Item $lkgPath -Recurse -Force }
        Copy-Item $distPath $lkgPath -Recurse -Force
        Write-Host "   known-good 갱신: $lkgPath" -ForegroundColor DarkGray
    }
    catch {
        Write-Host "   스냅샷 실패(무시): $_" -ForegroundColor Yellow
    }
}

function Restore-KnownGood {
    if (-not (Test-Path $lkgPath)) {
        Write-Host '   되돌릴 스냅샷이 없다 — 자동 복구 불가' -ForegroundColor Red
        return $false
    }

    try {
        if (Test-Path $distPath) { Remove-Item $distPath -Recurse -Force }
        Copy-Item $lkgPath $distPath -Recurse -Force
        Write-Host '   dist 를 known-good 으로 되돌림' -ForegroundColor Yellow
        return $true
    }
    catch {
        Write-Host "   롤백 실패: $_" -ForegroundColor Red
        return $false
    }
}

Push-Location $root
try {
    Write-Host '=== claudito safe restart (multi-instance, auto-rollback) ===' -ForegroundColor Cyan

    if (-not (Test-Path $configPath)) {
        Write-Host 'ecosystem.config.js 없음 - 재시작 중단.' -ForegroundColor Red
        exit 1
    }

    Write-Host '1) 검증 게이트' -ForegroundColor Cyan
    $ErrorActionPreference = 'Continue'
    if ($Static) { node scripts/validate.mjs --static } else { node scripts/validate.mjs }

    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host '검증 실패 - 재시작을 하지 않는다. 기존 인스턴스는 그대로 살아있다.' -ForegroundColor Red
        exit 1
    }
    $ErrorActionPreference = 'Stop'

    $ports = Get-TargetPorts

    Write-Host ''
    Write-Host "2) 재시작: $($ports -join ', ')" -ForegroundColor Green
    foreach ($p in $ports) {
        Invoke-Pm2 @('restart', "claudito-$p", '--update-env') | Out-Null
    }

    Write-Host '3) 헬스체크 (최대 30초 대기)' -ForegroundColor Cyan
    $failed = Wait-Healthy -Ports $ports

    if ($failed.Count -eq 0) {
        foreach ($p in $ports) { Write-Host "   :$p OK" -ForegroundColor Green }

        # 지금 돌고 있는 이 dist 는 방금 실제로 떠서 응답한 것이 확인됐다.
        # 이것만이 롤백 대상이 될 자격이 있다.
        if (-not $NoRollback) {
            Save-KnownGood
        }

        Invoke-Pm2 @('list') | Out-Null
        Write-Host ''
        Write-Host '재시작 완료 — 전부 정상.' -ForegroundColor Green
        exit 0
    }

    Write-Host "   실패: :$($failed -join ', ')" -ForegroundColor Red

    if ($NoRollback) {
        Write-Host '   -NoRollback 지정됨 — 자동 복구를 건너뛴다.' -ForegroundColor Yellow
        exit 1
    }

    Write-Host ''
    Write-Host '4) 자동 롤백' -ForegroundColor Yellow

    if (-not (Restore-KnownGood)) {
        Write-Host ''
        Write-Host '수동 조치가 필요하다. logs\claudito-<port>-err.log 를 확인하라.' -ForegroundColor Red
        exit 1
    }

    foreach ($p in $ports) {
        Invoke-Pm2 @('restart', "claudito-$p", '--update-env') | Out-Null
    }

    $stillBad = Wait-Healthy -Ports $ports

    if ($stillBad.Count -eq 0) {
        Write-Host ''
        Write-Host '롤백 성공 — 이전 빌드로 전부 정상 복구됐다.' -ForegroundColor Green
        Write-Host '방금 빌드한 코드에 문제가 있다. dist 는 이전 버전이므로 원인을 고친 뒤 다시 배포하라.' -ForegroundColor Yellow
        exit 2
    }

    Write-Host ''
    Write-Host "롤백 후에도 :$($stillBad -join ', ') 이 비정상 — 코드 문제가 아니다." -ForegroundColor Red
    Write-Host 'logs\claudito-<port>-err.log 와 워치독 로그를 확인하라.' -ForegroundColor Red
    exit 1
}
finally {
    Pop-Location
}
