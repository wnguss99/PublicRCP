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
# 2026-08-03: "재시작하지 않았는데 성공" 을 없앴다. 포트가 관리자 권한으로 뜬 예전
# 프로세스에 잡혀 있어 pm2 restart 가 세 개 다 실패했는데, 그 예전 프로세스가 200 을
# 돌려주는 바람에 스크립트는 성공(exit 0)을 반환하고 known-good 까지 갱신했다.
# 새 코드는 반영되지 않았고, 만약 그 코드가 깨져 있었다면 깨진 빌드가 known-good 으로
# 저장되어 자동 롤백이 무의미해진다. 그래서:
#
#   - pm2 restart 가 하나라도 실패하면 즉시 중단한다(교체가 없었으므로).
#   - 헬스체크는 200 만으로 통과시키지 않고, 그 포트를 물고 있는 PID 가 재시작 전과
#     달라졌는지도 확인한다. 이것이 "정말 교체됐는지" 를 아는 유일한 사실이다.
#   - known-good 갱신은 그 두 조건을 모두 통과한 뒤에만 한다.
#
# 사용:
#   powershell -ExecutionPolicy Bypass -File scripts/restart-safe.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/restart-safe.ps1 -Static     # 스모크 생략(빠름)
#   powershell -ExecutionPolicy Bypass -File scripts/restart-safe.ps1 -NoRollback # 롤백 끄기(디버깅용)
#
# 종료 코드:
#   0  재시작 성공(새 프로세스로 교체 확인됨)
#   1  검증 실패 / pm2 실패 / 롤백까지 실패 — 어느 쪽이든 메시지에 명시된다
#   2  롤백됨 — 방금 빌드한 코드가 원인이다
#   3  교체 실패 — 응답은 오지만 예전 프로세스다. 코드 문제가 아니므로 롤백하지 않는다
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

# Returns ONLY pm2's exit code.
#
# This used to let the wrapper's stdout fall through to the pipeline and then
# `return $LASTEXITCODE`, so the function actually returned an array of
# [...output, code]. `if ($exit -ne 0)` on an array does not compare — PowerShell
# filters it and hands back the non-matching elements, which is a non-empty array
# and therefore always truthy. Every caller was reading "pm2 failed" no matter what
# pm2 did; the check only looked correct while pm2 was genuinely failing. Print the
# output through Write-Host (which does not touch the pipeline) and return an int.
function Invoke-Pm2 {
    param([string[]]$Pm2Args)

    $ErrorActionPreference = 'Continue'
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $pm2Wrapper @Pm2Args 2>&1
    $code = $LASTEXITCODE

    foreach ($line in @($output)) {
        Write-Host "   $line" -ForegroundColor DarkGray
    }

    return [int]$code
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

# 각 포트를 실제로 listen 하고 있는 프로세스 ID.
#
# 재시작이 "일어났는지" 를 판정하는 유일한 사실이다. HTTP 응답만으로는 새 프로세스가
# 떴는지 알 수 없다 — 구 프로세스가 계속 답하고 있어도 200 이 온다.
# Get-NetTCPConnection 은 상대 프로세스가 관리자 권한이어도 소유 PID 를 알려주므로,
# 권한이 갈린 상황(2026-08-03) 에서도 판정할 수 있다.
function Get-PortOwners {
    param([string[]]$Ports)

    $owners = @{}

    foreach ($p in $Ports) {
        $ErrorActionPreference = 'Continue'
        $conn = Get-NetTCPConnection -LocalPort ([int]$p) -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
        $owners[[string]$p] = if ($conn) { [string]$conn.OwningProcess } else { $null }
    }

    return $owners
}

# 기동에는 몇 초가 걸린다. 한 번 찔러보고 실패로 단정하면 멀쩡한 배포를 롤백한다.
#
# "정상" 의 조건은 두 가지이며 둘 다 필요하다:
#   1. /api/health 가 200 을 준다
#   2. 그 포트를 물고 있는 PID 가 재시작 *전* 과 다르다
#
# 2번이 없던 동안 이런 일이 났다(2026-08-03): 포트가 관리자 권한으로 뜬 예전
# 프로세스에 잡혀 있어 pm2 restart 가 세 개 다 "Process not found" 로 실패했는데,
# 그 예전 프로세스가 200 을 돌려주는 바람에 스크립트는 성공으로 판정하고 known-good
# 까지 새 dist 로 갱신했다. 새 코드가 깨져 있었다면 깨진 빌드를 known-good 으로
# 저장하는 것이므로, 자동 롤백이라는 안전망 자체가 조용히 무력화된다.
function Wait-Healthy {
    param(
        [string[]]$Ports,
        [hashtable]$OwnersBefore,
        [int]$Attempts = 10,
        [int]$DelaySeconds = 3
    )

    $bad = @()
    $stale = @()

    for ($i = 1; $i -le $Attempts; $i++) {
        $bad = @()
        $stale = @()
        $ownersNow = Get-PortOwners -Ports $Ports

        foreach ($p in $Ports) {
            $healthy = $false

            try {
                $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/api/health" -UseBasicParsing -TimeoutSec 6
                $healthy = ($r.StatusCode -eq 200)
            }
            catch { $healthy = $false }

            if (-not $healthy) {
                $bad += $p
                continue
            }

            if ($OwnersBefore) {
                $before = $OwnersBefore[[string]$p]
                $now = $ownersNow[[string]$p]

                # 재시작 전에 아무도 안 물고 있었다면(인스턴스가 죽어 있던 경우)
                # 새로 뜬 것 자체가 교체 성공이다.
                if ($before -and $now -and $before -eq $now) {
                    $stale += $p
                }
            }
        }

        if ($bad.Count -eq 0 -and $stale.Count -eq 0) {
            return @{ Bad = @(); Stale = @() }
        }

        if ($i -lt $Attempts) {
            Start-Sleep -Seconds $DelaySeconds
        }
    }

    return @{ Bad = $bad; Stale = $stale }
}

# 디렉터리를 "항상 최소 하나의 온전한 사본이 남는" 방식으로 교체한다.
#
# 원래는 `Remove-Item 대상; Copy-Item 원본 대상` 이었다. 그 사이(수 초, dist 는
# 수백 개 파일)에 프로세스가 죽거나 정전이 나면 대상도 원본 사본도 없다. 롤백
# 경로에서 이 일이 나면 dist 가 사라져 어느 인스턴스도 뜨지 못하고, 원격에서는
# 손쓸 방법이 없어 사무실 방문으로 이어진다. 롤백은 이미 장애 상황에서 도는
# 코드이므로 그 자체가 복구 불가 상태를 만들어서는 안 된다.
#
# 대신 staging 으로 먼저 복사한 뒤 rename 으로 갈아끼운다. rename 은 같은 볼륨
# 안에서 메타데이터만 바꾸므로 사실상 원자적이고, 실패해도 .old 를 되돌릴 수 있다.
function Copy-DirectorySafely {
    param([string]$Source, [string]$Destination)

    $staging = "$Destination.staging"
    $old = "$Destination.old"
    $leaf = Split-Path $Destination -Leaf

    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    if (Test-Path $old) { Remove-Item $old -Recurse -Force }

    $parent = Split-Path $Destination -Parent
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    # 여기서 실패해도 대상은 아직 그대로다.
    Copy-Item $Source $staging -Recurse -Force

    $movedAside = $false

    try {
        if (Test-Path $Destination) {
            Rename-Item -Path $Destination -NewName "$leaf.old"
            $movedAside = $true
        }

        Rename-Item -Path $staging -NewName $leaf
    }
    catch {
        # 갈아끼우다 실패했으면 원래 대상을 되살린다. 반쪽짜리 상태로 두지 않는다.
        if ($movedAside -and -not (Test-Path $Destination)) {
            Rename-Item -Path $old -NewName $leaf -ErrorAction SilentlyContinue
        }
        throw
    }

    # 여기까지 왔으면 대상은 온전하다. 뒷정리 실패는 무해하다.
    if (Test-Path $old) { Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue }
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
        Copy-DirectorySafely -Source $distPath -Destination $lkgPath
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
        Copy-DirectorySafely -Source $lkgPath -Destination $distPath
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

    # 재시작 전 소유자를 기록해 둔다. 이게 없으면 "정말 교체됐는지" 를 판정할 수 없다.
    $ownersBefore = Get-PortOwners -Ports $ports

    # pm2 의 종료 코드를 버리면 안 된다. 예전에는 Out-Null 로 흘려보내서, pm2 가
    # EPERM 으로 아무것도 못 했는데도 헬스체크가 "이전 프로세스가 아직 살아있다"
    # 는 이유로 통과해 재시작이 성공한 것처럼 보였다.
    #
    # 출력만 하고 계속 진행하는 것도 같은 사고다(2026-08-03 재현). pm2 가 한 개라도
    # 실패했다면 교체는 일어나지 않았고, 그 상태로 진행하면 known-good 을 검증되지
    # 않은 dist 로 갱신하게 된다. 즉시 중단한다 — 기존 인스턴스는 살아 있으므로
    # 중단이 가장 안전한 선택이다.
    $pm2Failed = @()

    foreach ($p in $ports) {
        $exit = Invoke-Pm2 @('restart', "claudito-$p", '--update-env')
        if ($exit -ne 0) {
            Write-Host "   pm2 restart claudito-$p 실패 (exit $exit)" -ForegroundColor Red
            $pm2Failed += $p
        }
    }

    if ($pm2Failed.Count -gt 0) {
        Write-Host ''
        Write-Host "pm2 가 :$($pm2Failed -join ', ') 을 재시작하지 못했다 — 교체가 일어나지 않았다." -ForegroundColor Red
        Write-Host '기존 인스턴스는 그대로 살아 있고, known-good 도 건드리지 않았다.' -ForegroundColor Yellow
        Write-Host ''
        Write-Host '흔한 원인: 포트를 pm2 가 관리하지 않는 프로세스(예: 관리자 권한으로 직접 띄운 것)가' -ForegroundColor Yellow
        Write-Host '점유하고 있어 pm2 앱이 바인딩에 실패하고 waiting 으로 빠지는 경우.' -ForegroundColor Yellow
        Write-Host '확인: scripts\pm2.ps1 list  /  Get-NetTCPConnection -LocalPort <port> -State Listen' -ForegroundColor Yellow
        exit 1
    }

    Write-Host '3) 헬스체크 + 교체 확인 (최대 30초 대기)' -ForegroundColor Cyan
    $result = Wait-Healthy -Ports $ports -OwnersBefore $ownersBefore

    if ($result.Bad.Count -eq 0 -and $result.Stale.Count -eq 0) {
        foreach ($p in $ports) { Write-Host "   :$p OK (새 프로세스)" -ForegroundColor Green }

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

    # 응답은 오지만 PID 가 그대로라면 구 프로세스가 계속 답하고 있는 것이다. 새 코드는
    # 아예 로드되지 않았으므로 dist 를 되돌리는 것은 무의미하고(코드 문제가 아니다),
    # known-good 을 갱신하는 것은 위험하다. 별도 종료코드로 구분해 알린다.
    if ($result.Bad.Count -eq 0 -and $result.Stale.Count -gt 0) {
        Write-Host "   :$($result.Stale -join ', ') 은 응답하지만 재시작 전과 같은 프로세스다." -ForegroundColor Red
        Write-Host ''
        Write-Host '새 코드가 반영되지 않았다. 롤백은 하지 않는다 — 코드 문제가 아니라 교체 실패다.' -ForegroundColor Red
        Write-Host 'known-good 은 갱신하지 않았다. 포트를 물고 있는 프로세스를 정리한 뒤 다시 시도하라.' -ForegroundColor Yellow
        exit 3
    }

    Write-Host "   실패: :$($result.Bad -join ', ')" -ForegroundColor Red

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

    # 롤백 재시작 직전의 소유자. 여기서도 "응답하지만 예전 프로세스" 를 성공으로
    # 오판하면 복구됐다고 믿고 끝내버린다.
    $ownersBeforeRollback = Get-PortOwners -Ports $ports

    foreach ($p in $ports) {
        $exit = Invoke-Pm2 @('restart', "claudito-$p", '--update-env')
        if ($exit -ne 0) {
            Write-Host "   롤백 재시작 claudito-$p 실패 (exit $exit)" -ForegroundColor Red
        }
    }

    $rollbackResult = Wait-Healthy -Ports $ports -OwnersBefore $ownersBeforeRollback
    $stillBad = @($rollbackResult.Bad) + @($rollbackResult.Stale)

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
