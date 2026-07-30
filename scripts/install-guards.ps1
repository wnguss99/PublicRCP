<#
.SYNOPSIS
  claudito 멀티 인스턴스 재발방지 장치 설치 (1회 실행).

.DESCRIPTION
  2026-07-30 사고(3개 인스턴스 전부 다운 + 방치) 재발방지.
  설치 항목:

    1. git hooks 경로 활성화 (core.hooksPath=.githooks)
       → pre-commit: 평문 자격증명 커밋 차단 + 인스턴스 구성 검증
       → pre-push  : 기존 서버 안전 검증 게이트
    2. "Claudito Health Watchdog" 스케줄 작업 (5분 간격)
       → 죽은 인스턴스 자동 복구, logs\watchdog.log 기록
       → RunLevel=Highest (PM2 데몬과 권한 일치. 낮으면 EPERM 으로 복구 불가)
    3. "PM2 Resurrect (boot)" 작업 존재/권한 확인

  관리자 권한이 필요하므로 자동 승격한다.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/install-guards.ps1
#>
[CmdletBinding()]
param(
    [switch]$Elevated,

    # 감시 간격(분).
    [int]$IntervalMinutes = 5,

    # 추가로 접속을 허용할 사내 LAN 서브넷 (예: '192.168.0.0/23').
    # 지정하지 않으면 Tailscale 범위(100.64.0.0/10)만 열린다.
    # ⚠ LAN 을 열면 그 네트워크의 누구나 로그인 화면에 닿는다. 자격증명이
    #   admin/admin 같이 약하면 사실상 이 PC 를 넘겨주는 것과 같다.
    [string]$LanSubnet = '',

    # 스케줄 작업 제거.
    [switch]$Uninstall
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$watchdogPath = Join-Path $repoRoot 'scripts\watchdog.ps1'
$taskName = 'Claudito Health Watchdog'

$logDir = Join-Path $repoRoot 'logs'

if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

# 승격 실패/권한 판정 실패도 파일에 남아야 진단이 된다. 관리자 판정 전에 시작한다.
Start-Transcript -Path (Join-Path $logDir 'install-guards.log') -Force | Out-Null

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Tailscale CGNAT 범위. 기존 'claudito (Tailscale 4000)' 규칙과 같은 범위를 쓴다.
$TAILSCALE_RANGE = '100.64.0.0/10'

# 방화벽 규칙 대상 포트는 ecosystem.config.js 가 단일 진실 공급원이다.
# 인스턴스를 추가하면 규칙도 자동으로 따라오게 하려면 여기서 읽어야 한다.
function Get-InstancePorts {
    $configPath = Join-Path $repoRoot 'ecosystem.config.js'

    if (-not (Test-Path $configPath)) {
        return @()
    }

    $ErrorActionPreference = 'Continue'
    $raw = & node -e "const c=require('$($configPath -replace '\\', '/')');console.log(c.apps.map(a=>a.env.PORT).join(' '))" 2>&1

    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
        return @()
    }

    return ($raw | Out-String).Trim() -split '\s+'
}

function Set-FirewallRules {
    param(
        [Parameter(Mandatory)][string[]]$Ports,
        [string]$LanSubnet = ''
    )

    foreach ($port in $Ports) {
        $remote = @($TAILSCALE_RANGE)

        if (-not [string]::IsNullOrWhiteSpace($LanSubnet)) {
            $remote += $LanSubnet
        }

        $name = "claudito (Tailscale $port)"
        $existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue

        if ($existing) {
            Set-NetFirewallRule -DisplayName $name -RemoteAddress $remote -Enabled True | Out-Null
            Write-Host ("    갱신 :{0}  remote={1}" -f $port, ($remote -join ', ')) -ForegroundColor Green
            continue
        }

        New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP `
            -LocalPort $port -RemoteAddress $remote -Profile Any -Enabled True | Out-Null
        Write-Host ("    생성 :{0}  remote={1}" -f $port, ($remote -join ', ')) -ForegroundColor Green
    }

    if ([string]::IsNullOrWhiteSpace($LanSubnet)) {
        Write-Host '    (LAN 미개방 — 사내 PC 에서 접속시키려면 -LanSubnet 192.168.0.0/23)' -ForegroundColor DarkGray
    }
    else {
        Write-Host "    경고: LAN($LanSubnet) 의 누구나 로그인 화면에 닿는다. 자격증명을 강하게 유지할 것." -ForegroundColor Yellow
    }
}

if (-not (Test-IsAdmin)) {
    if ($Elevated) {
        Write-Host '승격했는데도 관리자 권한이 아니다 — UAC 승인이 거부됐거나 정책으로 막혀 있다.' -ForegroundColor Red
        try { Stop-Transcript | Out-Null } catch { }
        exit 1
    }

    Write-Host '관리자 권한으로 승격한다 (UAC 승인 필요)...' -ForegroundColor Yellow

    $argList = @(
        '-NoProfile'
        '-ExecutionPolicy', 'Bypass'
        '-NoExit'
        '-File', "`"$PSCommandPath`""
        '-Elevated'
        '-IntervalMinutes', "$IntervalMinutes"
    )

    if (-not [string]::IsNullOrWhiteSpace($LanSubnet)) {
        $argList += @('-LanSubnet', $LanSubnet)
    }

    if ($Uninstall) {
        $argList += '-Uninstall'
    }

    try { Stop-Transcript | Out-Null } catch { }

    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList
    }
    catch {
        Write-Host "승격 실패 (UAC 취소?): $_" -ForegroundColor Red
        exit 1
    }

    return
}

# ------------------------------------------------------------- elevated section

try {
    Set-Location $repoRoot

    if ($Uninstall) {
        Write-Host "[-] '$taskName' 제거" -ForegroundColor Yellow
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host '제거 완료.' -ForegroundColor Green
        return
    }

    Write-Host '[1/3] git hooks 경로 활성화' -ForegroundColor Cyan
    $ErrorActionPreference = 'Continue'
    & git config --local core.hooksPath .githooks
    $hooksPath = (& git config --local core.hooksPath)
    Write-Host "    core.hooksPath = $hooksPath" -ForegroundColor Green

    Write-Host "[2/3] '$taskName' 스케줄 작업 등록 ($IntervalMinutes 분 간격)" -ForegroundColor Cyan

    if (-not (Test-Path $watchdogPath)) {
        throw "watchdog.ps1 이 없다: $watchdogPath"
    }

    $action = New-ScheduledTaskAction `
        -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$watchdogPath`"" `
        -WorkingDirectory $repoRoot

    # 부팅 직후 + 로그온 직후 + N분마다 무기한 반복.
    #
    # BootTrigger 가 반드시 있어야 한다: PM2 부팅 작업과 달리 LogonTrigger 만 있으면
    # 재부팅 후 아무도 Windows 에 로그인하지 않는 동안 감시가 죽어 있다
    # (모바일에서만 접속하는 운영 방식에서는 그게 정상 상태다).
    #
    # RepetitionDuration 은 지정하지 않는다. 빈 값이 곧 "무기한"이고,
    # [TimeSpan]::MaxValue 를 주면 P99999999DT23H59M59S 로 직렬화돼
    # Task Scheduler 가 등록 자체를 거부한다.
    $triggerBoot = New-ScheduledTaskTrigger -AtStartup
    $triggerLogon = New-ScheduledTaskTrigger -AtLogOn
    $triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

    # PM2 데몬이 RunLevel=Highest 로 도니 감시자도 같은 권한이어야 pm2 조작이 된다.
    $principal = New-ScheduledTaskPrincipal `
        -UserId "$env:USERDOMAIN\$env:USERNAME" `
        -LogonType S4U `
        -RunLevel Highest

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

    # -ErrorAction Stop + 사후 검증. 예전에는 Register 가 실패해도(Duration 범위 초과)
    # 그대로 '등록 완료' 를 찍어서, 낡은 작업이 남아 있는 걸 성공으로 착각했다.
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger @($triggerBoot, $triggerLogon, $triggerRepeat) `
        -Principal $principal `
        -Settings $settings `
        -Description 'claudito 인스턴스 헬스체크 + 자동 복구 (2026-07-30 전체 다운 사고 재발방지)' `
        -Force -ErrorAction Stop | Out-Null

    $registered = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

    if ($null -eq $registered) {
        throw "'$taskName' 등록이 확인되지 않는다."
    }

    $hasBootTrigger = @($registered.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' }).Count -gt 0

    if (-not $hasBootTrigger) {
        throw "'$taskName' 에 부팅 트리거가 없다 — 재부팅 후 로그인 전까지 감시가 죽는다."
    }

    Write-Host "    등록 완료 (트리거: $(($registered.Triggers | ForEach-Object { $_.CimClass.CimClassName -replace 'MSFT_Task','' -replace 'Trigger','' }) -join ', '))" -ForegroundColor Green

    # 새 인스턴스를 추가할 때마다 잊는 단계. 4001/4002 를 띄운 뒤 "다른 PC 에서
    # 접속이 안 된다"고 했던 원인이 바로 이 규칙 누락이었다(4000 만 있었다).
    Write-Host '[3/4] 방화벽 인바운드 규칙 확인' -ForegroundColor Cyan
    $ports = Get-InstancePorts

    if ($ports.Count -eq 0) {
        throw 'ecosystem.config.js 에서 포트를 읽지 못해 방화벽 규칙을 만들 수 없다.'
    }

    Set-FirewallRules -Ports $ports -LanSubnet $LanSubnet

    Write-Host '[4/4] PM2 자동시작 작업 확인' -ForegroundColor Cyan
    $pm2Task = Get-ScheduledTask -TaskName 'PM2 Resurrect (boot)' -ErrorAction SilentlyContinue

    if ($null -eq $pm2Task) {
        Write-Host '    경고: "PM2 Resurrect (boot)" 작업이 없다 — 재부팅 후 인스턴스가 안 뜬다.' -ForegroundColor Yellow
    }
    else {
        $level = $pm2Task.Principal.RunLevel
        Write-Host "    존재함 (RunLevel=$level, State=$($pm2Task.State))" -ForegroundColor Green

        if ($level -ne 'Highest') {
            Write-Host '    경고: RunLevel 이 Highest 가 아니다 — watchdog 권한과 불일치할 수 있다.' -ForegroundColor Yellow
        }
    }

    Write-Host ''
    Write-Host '즉시 1회 감시 실행:' -ForegroundColor Cyan
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watchdogPath

    Write-Host ''
    Write-Host '설치 완료.' -ForegroundColor Green
    Write-Host "  감시 로그 : $(Join-Path $logDir 'watchdog.log')" -ForegroundColor DarkGray
    Write-Host "  수동 실행 : Start-ScheduledTask -TaskName '$taskName'" -ForegroundColor DarkGray
    Write-Host "  제거      : scripts/install-guards.ps1 -Uninstall" -ForegroundColor DarkGray
}
catch {
    Write-Host ''
    Write-Host "ERROR: $_" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkRed
}
finally {
    try { Stop-Transcript | Out-Null } catch { }
}
