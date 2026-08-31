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

# restart-safe.ps1 의 같은 이름 함수와 의도적으로 중복이다. 워치독은 스케줄
# 작업으로 도는 최후의 방어선이라, 공용 include 파일이 사라지거나 경로가 바뀌면
# 감시 자체가 멈춘다. 그 위험을 지는 대신 15줄을 복제한다.
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
        if ($movedAside -and -not (Test-Path $Destination)) {
            Rename-Item -Path $old -NewName $leaf -ErrorAction SilentlyContinue
        }
        throw
    }

    if (Test-Path $old) { Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue }
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

# 포트를 실제로 listen 하고 있는 프로세스 ID. 관리자 권한 프로세스여도 소유 PID 는
# 읽히므로, pm2 가 보고하는 PID 와 대조할 수 있다.
function Get-PortOwner {
    param([string]$Port)

    $conn = Get-NetTCPConnection -LocalPort ([int]$Port) -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($conn) { return [string]$conn.OwningProcess }
    return $null
}

# pm2 가 앱마다 보고하는 PID (name -> pid).
function Get-Pm2Pids {
    $ErrorActionPreference = 'Continue'
    $raw = & pm2.cmd jlist 2>&1

    if ($LASTEXITCODE -ne 0) { return $null }

    try {
        $map = @{}
        foreach ($app in ($raw | Out-String | ConvertFrom-Json)) {
            $map[[string]$app.name] = @{ Pid = [string]$app.pid; Status = [string]$app.pm2_env.status }
        }
        return $map
    }
    catch {
        return $null
    }
}

<#
포트가 응답한다고 pm2 가 그 인스턴스를 소유하고 있는 것은 아니다.

2026-08-10: pm2 의 claudito-4000/4001 이 EADDRINUSE 로 2,100 번 재시작하는 동안,
포트는 pm2 가 모르는 다른 프로세스가 쥐고 응답하고 있었다. 워치독은 헬스체크만
보므로 그 내내 "정상 — 전부 응답" 을 기록했고, 크래시 루프는 아무도 모르게
계속됐다. 그 루프가 매 회차 기동 정리를 돌려 살아 있는 에이전트를 죽였다
(그 원인 자체는 서버 기동 순서 수정으로 막았지만, 소유권 상실은 여전히 남는다).

`pm2 restart` 로는 이 상태가 복구되지 않는다 — pm2 가 띄우는 새 프로세스는
포트를 못 잡고 죽는다. delete → 포트 점유자 정리 → ecosystem start 가 필요하다.
#>
function Test-Pm2Ownership {
    param([Parameter(Mandatory)][string[]]$Ports)

    $pm2 = Get-Pm2Pids
    if ($null -eq $pm2) { return @() }

    $mismatched = @()

    foreach ($port in $Ports) {
        $name = "claudito-$port"
        if (-not $pm2.ContainsKey($name)) { continue }

        $owner = Get-PortOwner $port
        if (-not $owner) { continue }   # 포트가 안 열려 있으면 down 경로가 처리한다

        $reported = $pm2[$name].Pid

        if ($reported -ne $owner) {
            Write-Log "소유권 불일치: $name pm2=$reported / 실제 포트 점유=$owner (status=$($pm2[$name].Status))" 'WARN'
            $mismatched += $port
        }
    }

    return $mismatched
}

# delete → 포트 점유자 정리 → ecosystem 전체 start.
#
# 복구는 그 포트에서 돌던 Claude 에이전트를 전부 죽인다. 그래서 죽이기 전에 대상이
# 정말 claudito(node) 인지 확인한다. 다른 프로그램이 그 포트를 잡은 상황이라면
# 죽여도 claudito 는 살아나지 않으므로, 죽이지 않고 사람에게 넘기는 편이 낫다.
function Repair-Pm2Ownership {
    param([Parameter(Mandatory)][string[]]$Ports)

    Write-Log "소유권 복구 시작 — 포트 $($Ports -join ', ')" 'WARN'

    foreach ($port in $Ports) {
        & pm2.cmd delete "claudito-$port" 2>&1 | ForEach-Object { Write-Log "  $_" }
    }

    Start-Sleep -Seconds 2

    foreach ($port in $Ports) {
        $owner = Get-PortOwner $port
        if (-not $owner) { continue }

        $proc = Get-Process -Id ([int]$owner) -ErrorAction SilentlyContinue

        if ($null -eq $proc) { continue }

        if ($proc.ProcessName -notin @('node', 'node.exe')) {
            Write-Log "  포트 $port 점유자가 node 가 아니다 ($($proc.ProcessName), PID $owner) — 죽이지 않는다. 수동 확인 필요" 'ERROR'
            continue
        }

        Write-Log "  포트 $port 점유 PID $owner ($($proc.ProcessName)) 종료"
        Stop-Process -Id ([int]$owner) -Force -ErrorAction SilentlyContinue
    }

    Start-Sleep -Seconds 3
    & pm2.cmd start $configPath 2>&1 | ForEach-Object { Write-Log "  $_" }
    Start-Sleep -Seconds 5
    & pm2.cmd save 2>&1 | Out-Null
}

# 포트가 살아 있어도 채팅이 전부 실패할 수 있다: ANTHROPIC_API_KEY 가 사용 불가한
# 값이면 Claude CLI 가 구독 대신 그걸 써서 "Invalid API key" 로 끝난다(2026-07-30).
# 헬스체크만 보면 초록불이라 아무도 모른 채 방치되므로 여기서 같이 감시한다.
#
# OAuth 만료도 같은 모양이다(2026-08-31): "OAuth session expired and could not be
# refreshed" 로 모든 채팅이 실패했는데, 실패가 CLI 내부에서 나 claudito 로그에는
# 네 포트 전부 아무 기록이 없었고 나중에 갱신이 성공해 원인을 확정할 수 없었다.
# 실패하는 구간은 저장된 액세스 토큰이 만료된 채 갱신되지 않은 구간이고, 그건
# 밖에서 관측되므로 여기 남긴다 — 다음엔 추측이 아니라 시각과 지속시간이 남는다.
function Test-AuthWarning {
    param([Parameter(Mandatory)][string[]]$Ports)

    foreach ($port in $Ports) {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 8

            if ($h.authWarning) {
                # 조치가 코드마다 다르다. API 키는 환경변수를 고쳐야 하고, OAuth 는
                # 재로그인이 필요하다. 하나로 뭉뚱그리면 엉뚱한 곳을 보게 된다.
                $advice = switch -Wildcard ($h.authWarning) {
                    'OAUTH_REFRESH_TOKEN_EXPIRED' { "재로그인 필요 — 터미널에서 'claude' 실행 후 /login. 자격증명 파일은 네 인스턴스가 공유하므로 한 번만 하면 된다" }
                    'OAUTH_SESSION_EXPIRED'       { "액세스 토큰 만료 후 갱신 안 됨. 보통 다음 갱신에 스스로 낫는다. 이 줄이 계속 쌓이면 'claude' → /login" }
                    'OAUTH_CREDENTIALS_*'         { "Claude CLI 자격증명 파일 문제 — 터미널에서 'claude' 실행 후 로그인 상태 확인" }
                    default                       { "'npm run validate:instances' 로 확인" }
                }

                Write-Log "인증 경고 :$port → $($h.authWarning) — 채팅이 전부 실패한다. $advice" 'ERROR'
            }
        }
        catch {
            # 헬스 자체가 실패하면 위의 다운 감지가 처리한다.
        }
    }
}

# 세 인스턴스는 같은 dist/index.js 를 실행하지만, Node 는 시작 시점의 코드를 메모리에
# 들고 있다. 한 포트만 재시작하면 나머지는 조용히 이전 빌드로 계속 돈다.
# 파일 시각 비교는 오탐이 많아(빌드는 내용이 같아도 모든 파일을 다시 쓴다) 인스턴스가
# 보고하는 코드 지문끼리 비교한다.
function Test-BuildDrift {
    param([Parameter(Mandatory)][string[]]$Ports)

    $seen = @{}

    foreach ($port in $Ports) {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 8

            if ($h.buildId) {
                $seen[$port] = $h.buildId
            }
        }
        catch {
            # 다운은 위에서 처리한다.
        }
    }

    $distinct = @($seen.Values | Sort-Object -Unique)

    if ($distinct.Count -gt 1) {
        $detail = ($seen.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', '
        Write-Log "빌드 불일치 — 포트마다 다른 코드가 돈다 ($detail). 'npm run instances:restart' 로 전체를 맞춰라." 'ERROR'
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

# PM2 데몬은 관리자 권한으로 \\.\pipe\rpc.sock 을 소유한다. 일반 권한으로 이
# 스크립트가 돌면 모든 pm2 호출이 EPERM 으로 죽는데, 그 실패가 조용해서 워치독이
# "감시하고 있다" 는 착각만 남긴다. 2026-07-30 사고가 정확히 그 모습이었다.
# 스케줄 작업이 RunLevel=Highest 로 등록돼 있으면 여기를 통과한다.
$isElevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isElevated -and -not $CheckOnly) {
    Write-Log '관리자 권한 없이 실행됨 — pm2 조작이 전부 실패한다. 스케줄 작업의 RunLevel=Highest 를 확인하라 (npm run guards:install).' 'ERROR'
    exit 1
}

$ports = Get-InstancePorts

if ($ports.Count -eq 0) {
    exit 1
}

if (-not $CheckOnly) {
    Invoke-LogRotation -Ports $ports
}

$down = @($ports | Where-Object { -not (Test-Instance $_) })

if ($down.Count -eq 0) {
    # 정상으로 돌아왔으면 연속 실패 카운터를 지운다. 남겨두면 나중에 한 번만
    # 실패해도 곧바로 롤백이 돌아버린다.
    Remove-Item (Join-Path $logDir 'watchdog-failures.txt') -Force -ErrorAction SilentlyContinue

    Test-AuthWarning -Ports $ports
    Test-BuildDrift -Ports $ports

    # 응답한다고 정상인 것은 아니다. pm2 가 그 포트의 주인이 아니면 크래시 루프가
    # 조용히 돌고 있는 상태이므로, 여기서 잡지 않으면 영원히 "정상" 으로 기록된다.
    $ownershipState = Join-Path $logDir 'watchdog-ownership.txt'
    $stolen = @(Test-Pm2Ownership -Ports $ports)

    if ($stolen.Count -eq 0) {
        Remove-Item $ownershipState -Force -ErrorAction SilentlyContinue
        Write-Log "정상 — 포트 $($ports -join ', ') 전부 응답"
        exit 0
    }

    if ($CheckOnly) {
        Write-Log "소유권 불일치 감지 (CheckOnly — 복구하지 않음): 포트 $($stolen -join ', ')" 'ERROR'
        exit 1
    }

    # 복구는 그 포트의 에이전트를 전부 죽인다. 정상적인 재시작 도중에도 pm2 가 새 PID 를
    # 보고한 찰나에 옛 프로세스가 아직 포트를 쥐고 있을 수 있는데, 그 한 순간을 보고
    # 복구를 돌리면 멀쩡히 일하던 사람의 작업이 날아간다. 진짜 소유권 상실은 저절로
    # 낫지 않으므로(2026-08-10 사고는 며칠을 갔다) 두 주기 연속 같은 포트가 걸릴 때만
    # 손을 댄다. 늦어지는 비용은 몇 분, 오탐의 비용은 남의 작업이다.
    $current = (@($stolen | Sort-Object)) -join ','
    $prev = ''

    if (Test-Path $ownershipState) {
        $prev = (Get-Content $ownershipState -Raw -ErrorAction SilentlyContinue).Trim()
    }

    if ($prev -ne $current) {
        Set-Content -Path $ownershipState -Value $current -Encoding UTF8
        Write-Log "소유권 불일치 1회차 — 포트 $current. 재시작 직후일 수 있어 다음 주기에 다시 본다" 'WARN'
        exit 1
    }

    Write-Log "소유권 불일치 2회 연속 — 포트 $current. 복구한다" 'ERROR'
    Remove-Item $ownershipState -Force -ErrorAction SilentlyContinue

    Repair-Pm2Ownership -Ports $stolen

    $stillBad = @(Test-Pm2Ownership -Ports $ports)
    $stillDown = @($ports | Where-Object { -not (Test-Instance $_) })

    if ($stillBad.Count -eq 0 -and $stillDown.Count -eq 0) {
        Write-Log "소유권 복구 완료 — pm2 가 다시 주인이다"
        exit 0
    }

    Write-Log "소유권 복구 실패 — 불일치 $($stillBad -join ', ') / 미응답 $($stillDown -join ', ')" 'ERROR'
    exit 1
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

# 기동에는 수 초가 걸린다. 한 번 찔러보고 실패로 단정하면, 정상적으로 살아나는
# 중인 인스턴스를 실패로 세어 연속 실패 카운터가 쌓이고 결국 불필요한 롤백까지
# 간다. restart-safe.ps1 의 Wait-Healthy 와 같은 재시도 방식으로 맞춘다.
$stillDown = @($recovered)

for ($retry = 1; $retry -le 8; $retry++) {
    Start-Sleep -Seconds 4
    $stillDown = @($recovered | Where-Object { -not (Test-Instance $_) })

    if ($stillDown.Count -eq 0) { break }

    if ($retry -lt 8) {
        Write-Log "  헬스체크 재시도 $retry/8 — 미응답: $($stillDown -join ', ')"
    }
}

if ($stillDown.Count -eq 0) {
    Write-Log "복구 완료 — 포트 $($recovered -join ', ')"
    exit 0
}

Write-Log "복구 실패 — 포트 $($stillDown -join ', ') 여전히 다운" 'ERROR'

# 재시작으로 살아나지 않는다는 것은 대개 dist 가 깨졌다는 뜻이다. 재부팅 후
# PM2 가 깨진 빌드를 그대로 띄우면 restart-safe 를 거치지 않으므로 롤백도 일어나지
# 않고, 원격에서는 손쓸 방법이 없어 사무실 방문으로 이어진다.
# 연속 실패가 쌓였을 때만 마지막 수단으로 known-good 으로 되돌린다.
$statePath = Join-Path $logDir 'watchdog-failures.txt'
$fails = 0

if (Test-Path $statePath) {
    $raw = (Get-Content $statePath -Raw).Trim()
    if ($raw -match '^\d+$') { $fails = [int]$raw }
}

$fails++
Set-Content -Path $statePath -Value $fails -Encoding UTF8

$lkg = Join-Path $repoRoot '.lkg\dist'
$dist = Join-Path $repoRoot 'dist'

if ($fails -lt 2) {
    Write-Log "연속 실패 $fails 회 — 다음 주기에 롤백을 시도한다" 'WARN'
    exit 1
}

if (-not (Test-Path $lkg)) {
    Write-Log 'known-good 스냅샷이 없어 롤백 불가 — 수동 조치 필요' 'ERROR'
    exit 1
}

Write-Log "연속 실패 $fails 회 — known-good 빌드로 롤백 시도" 'WARN'

try {
    Copy-DirectorySafely -Source $lkg -Destination $dist
    Write-Log 'dist 를 known-good 으로 되돌림'
}
catch {
    Write-Log "롤백 실패: $_" 'ERROR'
    exit 1
}

# dist 를 갈아끼웠으므로 정상 포트도 메모리의 깨진 코드를 들고 있다 — 전부 재시작한다.
# `restart all` 대신 포트별로 도는 이유는, 하나가 실패해도 나머지는 올려야 하고
# 로그에 어느 포트가 문제였는지 남겨야 하기 때문이다.
foreach ($port in $ports) {
    Write-Log "롤백 후 restart claudito-$port"
    & pm2.cmd restart "claudito-$port" --update-env 2>&1 | ForEach-Object { Write-Log "  $_" }

    if ($LASTEXITCODE -ne 0) {
        Write-Log "  롤백 재시작 claudito-$port 실패 (exit $LASTEXITCODE)" 'ERROR'
    }
}

Start-Sleep -Seconds 12

$afterRollback = @($ports | Where-Object { -not (Test-Instance $_) })

if ($afterRollback.Count -eq 0) {
    Write-Log '롤백으로 복구 완료 — 최근 빌드에 문제가 있다. 원인을 고친 뒤 재배포하라.'
    Remove-Item $statePath -Force -ErrorAction SilentlyContinue
    exit 0
}

Write-Log "롤백 후에도 :$($afterRollback -join ', ') 다운 — 코드 문제가 아니다. logs\claudito-<port>-err.log 확인" 'ERROR'
exit 1
