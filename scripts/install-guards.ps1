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
    3. "Claude Token Renewal Reminder" 스케줄 작업 (매일 10:00)
       → 리프레시 토큰 만료 5일 전부터 갱신 창을 띄운다
       → LogonType=Interactive (S4U 면 데스크톱이 없어 창이 안 보인다)
    4. "PM2 Resurrect (boot)" 작업 존재/권한 확인

  관리자 권한이 필요하므로 자동 승격한다.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/install-guards.ps1
#>
[CmdletBinding()]
param(
    [switch]$Elevated,

    # 감시 간격(분). 이 값이 곧 "다운을 몰랐던 최대 시간" 이다.
    # 원격 전용 서버라 복구 지연이 곧 사무실 방문으로 이어지므로 짧게 잡는다.
    [int]$IntervalMinutes = 2,

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
$renewPath = Join-Path $repoRoot 'scripts\renew-claude-token.ps1'
$renewTaskName = 'Claude Token Renewal Reminder'

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
        # 등록하는 작업이 둘이므로 제거도 둘이다. 하나만 지우면 남은 쪽이
        # 조용히 계속 돌아, 제거했다고 믿는 상태와 실제가 어긋난다.
        foreach ($name in @($taskName, $renewTaskName)) {
            Write-Host "[-] '$name' 제거" -ForegroundColor Yellow
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
        }

        Write-Host '제거 완료.' -ForegroundColor Green
        return
    }

    Write-Host '[1/5] git hooks 경로 활성화' -ForegroundColor Cyan
    $ErrorActionPreference = 'Continue'
    & git config --local core.hooksPath .githooks
    $hooksPath = (& git config --local core.hooksPath)
    Write-Host "    core.hooksPath = $hooksPath" -ForegroundColor Green

    Write-Host "[2/5] '$taskName' 스케줄 작업 등록 ($IntervalMinutes 분 간격)" -ForegroundColor Cyan

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

    # ----------------------------------------------------------------------
    # Claude 리프레시 토큰은 30일마다 만료되고 스스로 복구되지 않는다. 만료되면
    # 네 인스턴스 전부 채팅이 멈춘다(2026-09-30 26시간, 2026-10-15 13시간).
    #
    # 메일과 UI 배너가 이미 알리지만 둘 다 '보고 있어야' 닿는다. 이 작업은 PC 앞에
    # 앉은 사람에게 창을 직접 띄운다 — 세 경로가 같은 refreshTokenExpiresInDays 를
    # 보고, 서로를 대체하지 않고 보강한다.
    Write-Host "[3/5] '$renewTaskName' 토큰 만료 알림 작업 등록" -ForegroundColor Cyan

    if (-not (Test-Path $renewPath)) {
        throw "renew-claude-token.ps1 이 없다: $renewPath"
    }

    # -RemindOnly 는 임박하지 않으면 조용히 끝낸다. 그래서 작업 자체는 창 없이
    # 매일 돌아도 되고, 띄울 때만 보이는 창을 새로 만든다.
    $renewAction = New-ScheduledTaskAction `
        -Execute 'powershell.exe' `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$renewPath`" -RemindOnly" `
        -WorkingDirectory $repoRoot

    # 매일 10:00 + 로그온 직후, 두 개를 함께 건다.
    #
    # 이 호스트에는 평소 대화형 세션이 없다(실측: quser 결과 없음, explorer.exe 없음,
    # 서비스가 세션 0 에서 돈다). Interactive 작업은 그 상태에서 실행되지 않으므로
    # Daily 트리거만 두면 아무도 로그인하지 않는 동안에는 한 번도 안 뜬다.
    #
    # StartWhenAvailable 이 놓친 실행을 로그인 후 따라잡아 주지만, 그건 따라잡기
    # 의미론에 기대는 것이다. 로그온 트리거는 '사람이 PC 앞에 앉은 순간' 을 직접
    # 가리킨다 — 그 순간이 갱신을 실제로 할 수 있는 유일한 시점이다.
    $renewTriggerDaily = New-ScheduledTaskTrigger -Daily -At '10:00'
    $renewTriggerLogon = New-ScheduledTaskTrigger -AtLogOn

    # S4U 로 등록하면 데스크톱 세션이 없어 창이 아무에게도 보이지 않는다. 그러면
    # 이 작업은 '동작하는데 아무 효과도 없는' 상태가 된다 — CLAUDE.md 에 같은
    # 이유로 토스트 알림이 기각된 기록이 있다. Interactive 여야 한다.
    #
    # 관리자 권한은 필요 없다. 자격증명 읽기·백업·claude 실행 전부 사용자 권한이면
    # 되고, RunLevel Highest 로 올리면 UAC 때문에 창이 더 안 뜬다.
    $renewPrincipal = New-ScheduledTaskPrincipal `
        -UserId "$env:USERDOMAIN\$env:USERNAME" `
        -LogonType Interactive `
        -RunLevel Limited

    $renewSettings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

    Register-ScheduledTask `
        -TaskName $renewTaskName `
        -Action $renewAction `
        -Trigger @($renewTriggerDaily, $renewTriggerLogon) `
        -Principal $renewPrincipal `
        -Settings $renewSettings `
        -Description 'Claude 리프레시 토큰 만료 임박 시 갱신 창을 띄운다 (2026-09-30 26시간 정지 재발방지)' `
        -Force -ErrorAction Stop | Out-Null

    $renewRegistered = Get-ScheduledTask -TaskName $renewTaskName -ErrorAction SilentlyContinue

    if ($null -eq $renewRegistered) {
        throw "'$renewTaskName' 등록이 확인되지 않는다."
    }

    # 등록은 됐는데 LogonType 이 S4U 면 창이 안 뜬다. 조용히 쓸모없어지는
    # 실패라서 여기서 명시적으로 막는다.
    if ($renewRegistered.Principal.LogonType -ne 'Interactive') {
        throw "'$renewTaskName' 의 LogonType 이 $($renewRegistered.Principal.LogonType) 다 — Interactive 가 아니면 창이 보이지 않는다."
    }

    # 로그온 트리거가 빠지면 아무도 로그인하지 않는 평소 상태에서 한 번도 안 뜬다.
    # 워치독의 부팅 트리거 검증과 같은 이유로 여기서 막는다.
    $hasLogonTrigger = @($renewRegistered.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' }).Count -gt 0

    if (-not $hasLogonTrigger) {
        throw "'$renewTaskName' 에 로그온 트리거가 없다 — 이 호스트는 평소 대화형 세션이 없어, 그러면 창이 뜰 기회 자체가 없다."
    }

    Write-Host "    등록 완료 (매일 10:00 + 로그온 시, LogonType=Interactive)" -ForegroundColor Green

    # 새 인스턴스를 추가할 때마다 잊는 단계. 4001/4002 를 띄운 뒤 "다른 PC 에서
    # 접속이 안 된다"고 했던 원인이 바로 이 규칙 누락이었다(4000 만 있었다).
    Write-Host '[4/5] 방화벽 인바운드 규칙 확인' -ForegroundColor Cyan
    $ports = Get-InstancePorts

    if ($ports.Count -eq 0) {
        throw 'ecosystem.config.js 에서 포트를 읽지 못해 방화벽 규칙을 만들 수 없다.'
    }

    Set-FirewallRules -Ports $ports -LanSubnet $LanSubnet

    Write-Host '[5/5] PM2 자동시작 작업 확인' -ForegroundColor Cyan
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
