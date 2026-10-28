<#
.SYNOPSIS
  Claude 리프레시 토큰 갱신 — 안내 + 백업 + 전후 비교.

.DESCRIPTION
  리프레시 토큰은 30일마다 만료되고 스스로 복구되지 않는다. 만료되면 네 인스턴스
  전부 채팅이 멈춘다(2026-09-30 에 26시간 정지, 2026-10-15 에도 13시간).

  로그인 자체는 자동화할 수 없다. 비대화형으로 돌리면 입력을 기다리다 끝나지
  않는다 — OAuth 는 사람이 브라우저에서 본인임을 증명하는 것이 목적이라,
  스크립트가 사람 없이 통과할 수 있으면 보안 모델이 무너진다.

  쓰는 명령은 `claude auth login` 이다. `claude setup-token` 이 아니다 —
  2026-10-20 에 그것으로 로그인까지 마쳤는데 자격증명 파일이 전혀 바뀌지 않아
  만료가 그대로였다. setup-token 은 환경변수용 장기 토큰을 출력할 뿐이다.

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

# 로그인 명령이 이 파일을 건드렸는지 보려고 잡아둔다. 만료일 비교만으로는
# 2026-10-20 의 실패를 설명하지 못했다 — 그때는 로그인이 성공한 것처럼 보였고
# 만료일만 그대로였다. 파일이 아예 안 바뀌었다는 사실이 더 직접적인 신호다.
$mtimeBefore = (Get-Item $credentials).LastWriteTime

# ── 3. 갱신 ────────────────────────────────────────────────────────────────
Section '3. 토큰 갱신'

if ($WhatIf) {
    Write-Host '  -WhatIf — `claude auth login` 을 실행하지 않는다.' -ForegroundColor Yellow
}
else {
    Write-Host '  이제 브라우저가 열리거나 URL 과 코드가 표시된다.' -ForegroundColor White
    Write-Host '  jh@vms-solutions.com (VMS-SOLUTIONS) 으로 로그인하면 된다.' -ForegroundColor White
    Write-Host ''
    Write-Host '  이 단계만은 사람이 해야 한다 — 자동화할 수 없다.' -ForegroundColor DarkGray
    Write-Host ''

    <#
    `claude auth login` 이어야 한다. `setup-token` 이 아니다.

    2026-10-20 에 이 스크립트가 setup-token 을 돌렸고 사용자가 브라우저 로그인까지
    마쳤는데, 아무것도 갱신되지 않았다: refreshTokenExpiresAt 0.0일 변화,
    .credentials.json 의 mtime 은 8시간 주기 자동 갱신 시각 그대로,
    CLAUDE_CODE_OAUTH_TOKEN·ANTHROPIC_API_KEY·ANTHROPIC_AUTH_TOKEN 전부 미설정.

    setup-token 은 환경변수에 넣어 쓰는 장기 토큰을 출력할 뿐, 이 경로의
    자격증명 파일을 바꾸지 않는다. claudito·워치독·CLI 세션이 읽는 것은
    .credentials.json 이고, 그것을 갱신하는 것은 auth login 이다.

    Start-Job 이나 리디렉션으로 감싸면 안 된다. 대화형 프롬프트가 콘솔을
    직접 써야 하고, 감싸는 순간 입력을 못 받아 그대로 멈춘다.
    #>
    & claude auth login

    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host "  auth login 이 0 이 아닌 코드로 끝났다 (exit=$LASTEXITCODE)." -ForegroundColor Yellow
        Write-Host '  아래 결과를 확인하라.' -ForegroundColor Yellow
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

$mtimeAfter = (Get-Item $credentials -ErrorAction SilentlyContinue).LastWriteTime
$fileTouched = $mtimeAfter -ne $mtimeBefore

if ($WhatIf) {
    Write-Host '  (-WhatIf 이므로 변화 없음이 정상)' -ForegroundColor DarkGray
}
elseif ($improved) {
    $gain = ([DateTimeOffset]$after.refreshTokenExpiresAt - [DateTimeOffset]$before.refreshTokenExpiresAt).TotalDays
    Write-Host ("  ✓ 갱신 성공 — 만료일이 {0:N1} 일 뒤로 밀렸다." -f $gain) -ForegroundColor Green
    Write-Host "    새 만료일까지 $($after.refreshTokenExpiresInDays) 일 남았다." -ForegroundColor Green
}
elseif (-not $fileTouched) {
    # 2026-10-20 이 정확히 이 경우였다. 브라우저 로그인은 성공했는데 명령이
    # 이 파일을 건드리지 않아 아무것도 바뀌지 않았고, 화면에는 '만료일이
    # 늘어나지 않았다' 만 떠서 그게 실패라는 게 전달되지 않았다.
    Write-Host '  ✗ 자격증명 파일이 전혀 바뀌지 않았다 — 갱신되지 않았다.' -ForegroundColor Red
    Write-Host "    $credentials" -ForegroundColor DarkGray
    Write-Host "    수정시각이 그대로다: $mtimeBefore" -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '    로그인 화면을 통과했더라도, 그 명령이 이 파일을 쓰지 않으면' -ForegroundColor Yellow
    Write-Host '    아무 효과가 없다. 터미널에서 직접 실행해 보라:' -ForegroundColor Yellow
    Write-Host '      claude auth login' -ForegroundColor White
}
else {
    # 파일은 바뀌었는데 만료일이 안 늘었다 = 8시간 주기 자동 갱신이 끼어든 것일
    # 수 있다. 위와 원인이 다르므로 안내도 달라야 한다.
    Write-Host '  ✗ 파일은 바뀌었지만 만료일이 늘어나지 않았다.' -ForegroundColor Red
    Write-Host "    수정시각: $mtimeBefore → $mtimeAfter" -ForegroundColor DarkGray
    Write-Host '    액세스 토큰 자동 갱신만 일어났을 수 있다. 다시 시도하라:' -ForegroundColor Yellow
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
