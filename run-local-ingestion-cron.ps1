
$ErrorActionPreference = "Stop"

# Find the project root from this script's location
$projectRoot = $PSScriptRoot
$envFile = Join-Path $projectRoot "server\.env"
$logFile = Join-Path $projectRoot "local-ingestion-cron.log"

try {
    if (!(Test-Path $envFile)) {
        throw "Cannot find server\.env at $envFile"
    }

    # Read CRON_SECRET without printing it
    $line = Get-Content $envFile |
        Where-Object { $_ -match '^\s*CRON_SECRET\s*=' } |
        Select-Object -First 1

    if (!$line) {
        throw "CRON_SECRET was not found in server\.env"
    }

    $secret = ($line -replace '^\s*CRON_SECRET\s*=\s*', '').Trim()
    $secret = $secret.Trim('"').Trim("'")

    if (!$secret) {
        throw "CRON_SECRET is empty"
    }

    $headers = @{ Authorization = "Bearer $secret" }

    $result = Invoke-RestMethod `
        -Uri "http://localhost:4000/api/cron/ingest" `
        -Headers $headers `
        -Method Get `
        -TimeoutSec 50

    $summary = @{
        time = (Get-Date).ToString("s")
        results = $result.results
    } | ConvertTo-Json -Depth 8 -Compress

    Add-Content -Path $logFile -Value $summary
}
catch {
    Add-Content -Path $logFile -Value (
        "$(Get-Date -Format s) ERROR: $($_.Exception.Message)"
    )
}
