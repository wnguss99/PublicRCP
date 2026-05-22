# Claudito HTTPS Quick Start (cert already generated)
# Run: .\start-https-quick.ps1

if (-not (Test-Path ".env.https")) {
    Write-Host "No .env.https found. Run start-https.ps1 first." -ForegroundColor Red
    exit 1
}

# Load saved env
Get-Content ".env.https" | ForEach-Object {
    if ($_ -match "^([^=]+)=(.+)$") {
        [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
}

$domain = $env:TAILSCALE_DOMAIN
$env:PORT = "4000"

Write-Host "Starting Claudito over HTTPS..." -ForegroundColor Green
Write-Host "Access at: https://$domain:4000" -ForegroundColor Yellow

npm start
