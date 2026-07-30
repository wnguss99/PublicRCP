<#
.SYNOPSIS
  claudito 전용 pm2 래퍼 — 항상 관리자 권한으로 pm2 를 실행한다.

.DESCRIPTION
  PM2 자동시작 스케줄 작업("PM2 Resurrect (boot)")이 RunLevel=Highest 로
  등록돼 있어 PM2 데몬이 관리자 권한으로 돌고 \\.\pipe\rpc.sock 을 소유한다.
  일반 권한 PowerShell 에서 pm2 를 치면 아래로 즉사한다.

      connect EPERM \\.\pipe\rpc.sock

  2026-07-30 에 3개 인스턴스가 전부 내려간 채 방치된 원인이 이거였다.
  맨손으로 `pm2 ...` 치지 말고 항상 이 래퍼를 쓴다.

      npm run pm2 -- list
      npm run pm2 -- logs claudito-4001 --lines 50
      npm run pm2 -- restart claudito-4002 --update-env

  이미 관리자 권한이면 그대로 실행하고, 아니면 승격해서 실행한 뒤
  자식 프로세스의 출력을 임시 로그로 회수해 여기에 그대로 뿌린다.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/pm2.ps1 list
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Pm2Args = @()
)

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Pm2Args.Count -eq 0) {
    $Pm2Args = @('list')
}

if (Test-IsAdmin) {
    # 네이티브 stderr 가 종료 오류로 승격되지 않도록 Continue 로 둔다.
    $ErrorActionPreference = 'Continue'
    & pm2.cmd @Pm2Args
    exit $LASTEXITCODE
}

$outFile = Join-Path $env:TEMP ("claudito-pm2-{0}.log" -f $PID)

# 승격된 자식은 별도 콘솔이라 부모가 출력을 볼 수 없다. 파일로 받아서 되돌린다.
#
# -Command 로 넘기면 안 된다: Start-Process 는 공백이 든 인수를 다시 따옴표로
# 감싸는데, 그 안에 이미 따옴표가 있으면 명령이 깨져 스크립트가 아예 실행되지
# 않는다(로그 파일조차 안 생긴다). -EncodedCommand 는 base64 라 인용 문제가 없다.
$innerCommand = '& pm2.cmd {0} 2>&1 | Out-File -FilePath "{1}" -Encoding UTF8; exit $LASTEXITCODE' -f ($Pm2Args -join ' '), $outFile
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($innerCommand))

$inner = @(
    '-NoProfile'
    '-ExecutionPolicy', 'Bypass'
    '-EncodedCommand', $encoded
)

Write-Host "pm2 $($Pm2Args -join ' ')  (관리자 권한으로 승격 — UAC 승인 필요)" -ForegroundColor Yellow

try {
    $proc = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $inner -Wait -PassThru -WindowStyle Hidden
}
catch {
    Write-Host "UAC 승인이 거부됐거나 승격에 실패했다: $_" -ForegroundColor Red
    exit 1
}

if (Test-Path $outFile) {
    Get-Content $outFile | ForEach-Object { Write-Host $_ }
    Remove-Item $outFile -Force -ErrorAction SilentlyContinue
}

exit $proc.ExitCode
