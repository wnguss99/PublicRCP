# Claudito HTTPS Starter via Tailscale
# Run once: .\start-https.ps1

$ErrorActionPreference = "Stop"

# 1. Get Tailscale domain
Write-Host "Detecting Tailscale domain..." -ForegroundColor Cyan
$domain = (tailscale cert 2>&1 | Select-String "wrote" | ForEach-Object { $_ -replace '.*wrote (.*\.crt).*','$1' } | ForEach-Object { $_ -replace '\.crt','' })

if (-not $domain) {
    # Fallback: get domain from tailscale status
    $tsStatus = tailscale status --json | ConvertFrom-Json
    $dnsSuffix = $tsStatus.MagicDNSSuffix
    $selfName = ($tsStatus.Self.DNSName -split '\.')[0]
    $domain = "$selfName.$dnsSuffix"

    Write-Host "Generating cert for: $domain" -ForegroundColor Cyan
    tailscale cert $domain
}

$certFile = Join-Path (Get-Location) "$domain.crt"
$keyFile  = Join-Path (Get-Location) "$domain.key"

if (-not (Test-Path $certFile) -or -not (Test-Path $keyFile)) {
    Write-Error "Cert files not found: $certFile"
    exit 1
}

Write-Host "Cert ready: $domain" -ForegroundColor Green

# 2. Save domain to .env.https for reuse
@"
HTTPS_CERT=$certFile
HTTPS_KEY=$keyFile
TAILSCALE_DOMAIN=$domain
"@ | Set-Content ".env.https"

# 3. Start server with HTTPS
Write-Host "Starting Claudito over HTTPS..." -ForegroundColor Green
Write-Host "Access at: https://$domain:4000" -ForegroundColor Yellow

$env:HTTPS_CERT = $certFile
$env:HTTPS_KEY  = $keyFile
$env:PORT       = "4000"

npm start
