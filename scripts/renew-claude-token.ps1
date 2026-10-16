<#
.SYNOPSIS
  Claude 리프레시 토큰 갱신 — 안내 + 백업 + 전후 비교.

.DESCRIPTION
  리프레시 토큰은 30일마다 만료되고 스스로 복구되지 않는다. 만료되면 네 인스턴스
  전부 채팅이 멈춘다(2026-09-30 에 26시간 정지, 2026-10-15 에도 13시간).

  로그인 자체는 자동화할 수 없다. `claude setup-token` 을 비대화형으로 돌리면
  입력을 기다리다 끝나지 않는다 — OAuth 는 사람이 브라우저에서 본인임을 증명하는
  것이 목적이라, 스크립트가 사람 없이 통과할 수 있으면 보안 모델이 무너진다.

  그래서 이 스크립트가 하는 일은 '대신 로그인' 이 아니라 **사람이 할 일을 한 번의
  브라우저 인증으로 줄이는 것**이다. 날짜를 기억하고, 명령어를 기억하고, 결과를
  직접 해석하던 부분을 전부 가져간다.

.PARAMETER WhatIf
  `claude setup-token` 을 실행하지 않고 나머지 단계만 돈다. 배포 전 검증용.

.PARAMETER RemindOnly
  만료가 임박했을 때만 창을 띄우고, 아니면 아무것도 하지 않고 끝낸다.
  예약 작업이 매일 이 모드로 호출한다. 이 모드가 없으면 매일 창이 깜빡여서,
  정작 중요한 날에도 그냥 닫게 된다.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/renew-claude-token.ps1
  powershell -ExecutionPolicy Bypass -File scripts/renew-claude-token.ps1 -WhatIf
#>
[CmdletBinding()]
param(
    [switch]$WhatIf,
    [switch]$RemindOnly,
    # /api/health·워치독·메일 경보가 쓰는 REFRESH_TOKEN_WARN_DAYS 와 같은 값.
    [int]$RemindDays = 5
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
$distUtil = Join-Path $repoRoot 'dist\utils\claude-oauth.js'
$backupDir = 'D:\tmp'
$credentials = Join-Path $env:USERPROFILE '.claude\.credentials.json'

function Section([string]$t) {
    Write-Host ''
    Write-Host "── $t " -ForegroundColor Cyan -NoNewline
    Write-Host ('─' * [Math]::Max(0, 60 - $t.Length)) -ForegroundColor DarkCyan
}

<#
만료 판정을 여기서 다시 구현하지 않는다.

같은 규칙이 두 곳에 있으면 한쪽만 고쳐지고, 그때 틀리는 쪽은 사람이 덜 보는
이쪽이다. /api/health 와 워치독과 메일 경보가 모두 describeClaudeOauth() 를 보고
있으니 이 스크립트도 같은 것을 본다.
#>
function Get-OauthStatus {
    if (-not (Test-Path $distUtil)) {
        return $null
    }

    $json = & node -e "const{describeClaudeOauth}=require('$($distUtil -replace '\\','/')');console.log(JSON.stringify(describeClaudeOauth()))" 2>&1

    if ($LASTEXITCODE -ne 0) { return $null }

    try { return ($json | Out-String | ConvertFrom-Json) } catch { return $null }
}

function Show-Status($s, [string]$label) {
    if ($null -eq $s) {
        Write-Host "  $label : 읽을 수 없음" -ForegroundColor Red
        return
    }

    $rt = if ($s.refreshTokenExpiresAt) { ([DateTimeOffset]$s.refreshTokenExpiresAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss') } else { '(없음)' }
    Write-Host "  $label"
    Write-Host "    리프레시 토큰 만료 : $rt"
    Write-Host "    남은 기간          : $($s.refreshTokenExpiresInDays) 일"
    Write-Host "    경고 코드          : $(if ($s.warningCode) { $s.warningCode } else { '(없음 — 정상)' })"
}

<#
예약 작업이 매일 호출하는 경로. 임박하지 않았으면 조용히 끝낸다.

창을 띄우는 쪽은 이 프로세스가 아니라 새로 만드는 프로세스다. 작업은 창 없이
돌아야 매일 깜빡이지 않고, 정작 띄울 때는 사람이 읽을 수 있는 창이어야 한다.
#>
if ($RemindOnly) {
    $s = Get-OauthStatus

    # 읽지 못했으면 조용히 끝낸다. 매일 도는 작업이 dist 부재 같은 사유로
    # 창을 띄우기 시작하면, 그 창은 곧 '그냥 닫는 창' 이 된다.
    if ($null -eq $s -or $null -eq $s.refreshTokenExpiresInDays) { exit 0 }
    if ($s.refreshTokenExpiresInDays -gt $RemindDays) { exit 0 }

    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -ArgumentList '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
    exit 0
}

Write-Host ''
Write-Host '  Claude 토큰 갱신' -ForegroundColor White
Write-Host '  ================' -ForegroundColor DarkGray

# ── 1. 현재 상태 ───────────────────────────────────────────────────────────
Section '1. 현재 상태'

$before = Get-OauthStatus

if ($null -eq $before) {
    Write-Host '  만료 정보를 읽지 못했다.' -ForegroundColor Red
    Write-Host "  dist 가 없거나 오래됐을 수 있다 (찾은 경로: $distUtil)" -ForegroundColor Yellow
    Write-Host '  저장소에서 `npm run build` 를 먼저 실행하라.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  판정 규칙을 여기서 따로 구현하지 않는 이유는, 규칙이 두 곳으로' -ForegroundColor DarkGray
    Write-Host '  갈라지면 한쪽만 고쳐지기 때문이다. 빌드 후 다시 실행하라.' -ForegroundColor DarkGray
    exit 1
}

Show-Status $before '갱신 전'

if ($before.refreshTokenExpiresInDays -gt 5 -and -not $WhatIf) {
    Write-Host ''
    Write-Host "  아직 $($before.refreshTokenExpiresInDays) 일 남았다. 지금 갱신해도 문제는 없다." -ForegroundColor DarkGray
}

# ── 2. 백업 ────────────────────────────────────────────────────────────────
Section '2. 자격증명 백업'

if (-not (Test-Path $credentials)) {
    Write-Host "  자격증명 파일이 없다: $credentials" -ForegroundColor Red
    Write-Host '  `claude auth login` 으로 처음부터 로그인해야 한다.' -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Force $backupDir | Out-Null }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $backupDir "claude-credentials-backup-$stamp.json"
Copy-Item $credentials $backup -Force

# 백업이 유효한지 확인하고 넘어간다. 깨진 백업은 백업이 아니다.
try {
    $null = (Get-Content $backup -Raw | ConvertFrom-Json).claudeAiOauth
    Write-Host "  ✓ $backup" -ForegroundColor Green
    Write-Host "    ($(([IO.FileInfo]$backup).Length) bytes, JSON 파싱 정상)" -ForegroundColor DarkGray
}
catch {
    Write-Host '  ✗ 백업이 유효한 JSON 이 아니다 — 중단한다.' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '  이 파일 하나가 네 인스턴스 전체의 인증이다. 문제가 생기면' -ForegroundColor DarkGray
Write-Host "  이 백업을 $credentials 로 되돌리면 된다." -ForegroundColor DarkGray

# ── 3. 갱신 ────────────────────────────────────────────────────────────────
Section '3. 토큰 갱신'

if ($WhatIf) {
    Write-Host '  -WhatIf — `claude setup-token` 을 실행하지 않는다.' -ForegroundColor Yellow
}
else {
    Write-Host '  이제 브라우저가 열리거나 URL 과 코드가 표시된다.' -ForegroundColor White
    Write-Host '  jh@vms-solutions.com (VMS-SOLUTIONS) 으로 로그인하면 된다.' -ForegroundColor White
    Write-Host ''
    Write-Host '  이 단계만은 사람이 해야 한다 — 자동화할 수 없다.' -ForegroundColor DarkGray
    Write-Host ''

    # Start-Job 이나 리디렉션으로 감싸면 안 된다. 대화형 프롬프트가 콘솔을
    # 직접 써야 하고, 감싸는 순간 입력을 못 받아 그대로 멈춘다.
    & claude setup-token

    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host "  setup-token 이 0 이 아닌 코드로 끝났다 (exit=$LASTEXITCODE)." -ForegroundColor Yellow
        Write-Host '  아래 결과를 확인하고, 안 늘어났으면 `claude auth login` 을 시도하라.' -ForegroundColor Yellow
    }
}

# ── 4. 전후 비교 ───────────────────────────────────────────────────────────
Section '4. 결과'

$after = Get-OauthStatus
Show-Status $before '갱신 전'
Show-Status $after  '갱신 후'

$improved = $false

if ($null -ne $after -and $null -ne $before -and
    $after.refreshTokenExpiresAt -and $before.refreshTokenExpiresAt) {
    $improved = ([DateTimeOffset]$after.refreshTokenExpiresAt) -gt ([DateTimeOffset]$before.refreshTokenExpiresAt)
}

Write-Host ''

if ($WhatIf) {
    Write-Host '  (-WhatIf 이므로 변화 없음이 정상)' -ForegroundColor DarkGray
}
elseif ($improved) {
    $gain = ([DateTimeOffset]$after.refreshTokenExpiresAt - [DateTimeOffset]$before.refreshTokenExpiresAt).TotalDays
    Write-Host ("  ✓ 갱신 성공 — 만료일이 {0:N1} 일 뒤로 밀렸다." -f $gain) -ForegroundColor Green
    Write-Host "    새 만료일까지 $($after.refreshTokenExpiresInDays) 일 남았다." -ForegroundColor Green
}
else {
    Write-Host '  ✗ 만료일이 늘어나지 않았다.' -ForegroundColor Red
    Write-Host '    setup-token 이 기대와 다르게 동작했을 수 있다. 대안:' -ForegroundColor Yellow
    Write-Host '      claude auth login' -ForegroundColor White
}

# ── 5. 인스턴스 확인 ───────────────────────────────────────────────────────
Section '5. 인스턴스 상태'

foreach ($port in 4000, 4001, 4002, 4003) {
    try {
        $h = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 8
        $warn = if ($h.authWarning) { $h.authWarning } else { '(없음)' }
        $colour = if ($h.authWarning) { 'Yellow' } else { 'Green' }
        Write-Host "  포트 $port : $($h.status)  authWarning=$warn" -ForegroundColor $colour
    }
    catch {
        Write-Host "  포트 $port : 응답 없음" -ForegroundColor Red
    }
}

Write-Host ''
Write-Host '  자격증명 파일은 네 인스턴스가 공유하므로 재시작은 필요 없다.' -ForegroundColor DarkGray
Write-Host ''
