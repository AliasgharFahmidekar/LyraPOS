$ErrorActionPreference = 'Continue'

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportDir = Join-Path $env:TEMP "LyraPOS-Diagnostics-$timestamp"
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null

function ConvertTo-SafeText([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $safe = $Text
    $safe = $safe -replace '(?i)(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*("[^"]*"|''[^'']*''|\S+)', '$1=[REDACTED]'
    $safe = $safe -replace '(?i)Bearer\s+[A-Za-z0-9._~+/-]+=*', 'Bearer [REDACTED]'
    return $safe
}

function Get-SafePath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $Path }
    return $Path.Replace($env:USERPROFILE, '%USERPROFILE%').Replace($env:APPDATA, '%APPDATA%')
}

$report = [ordered]@{
    collected_at = (Get-Date).ToString('o')
    computer_name = $env:COMPUTERNAME
    windows = $null
    app_processes = @()
    port_3001 = @()
    health = $null
    app_data_candidates = @()
    files = @()
    disk = @()
    notes = @(
        'Database files are not copied or modified.',
        'Only bounded log tails and file metadata are included.',
        'Authorization and common secret patterns are redacted from log excerpts.'
    )
}

try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $report.windows = @{
        caption = $os.Caption
        version = $os.Version
        build = $os.BuildNumber
        architecture = $os.OSArchitecture
    }
} catch { $report.windows = @{ error = $_.Exception.Message } }

try {
    $report.app_processes = @(Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -match 'LyraPOS|flo' } |
        Select-Object ProcessName, Id, StartTime)
} catch { }

try {
    $listeners = @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction Stop)
    foreach ($listener in $listeners) {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
        $report.port_3001 += @{
            local_address = $listener.LocalAddress
            local_port = $listener.LocalPort
            process_id = $listener.OwningProcess
            process_name = $processInfo.Name
            executable_path = Get-SafePath $processInfo.ExecutablePath
        }
    }
} catch {
    $report.port_3001 = @(@{ error = 'Unable to query listener details; check whether port 3001 is listening.' })
}

try {
    $health = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/api/health' -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    $report.health = @{
        http_status = [int]$health.StatusCode
        body = $health.Content
    }
} catch {
    $status = $null
    if ($_.Exception.Response) {
        try { $status = [int]$_.Exception.Response.StatusCode } catch { }
    }
    $report.health = @{
        http_status = $status
        error = $_.Exception.Message
    }
}

$candidates = @(
    (Join-Path $env:APPDATA 'LyraPOS'),
    (Join-Path $env:APPDATA 'lyrapos-desktop'),
    (Join-Path $env:APPDATA 'Flo')
) | Select-Object -Unique

foreach ($root in $candidates) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $report.app_data_candidates += Get-SafePath $root

    $candidateFiles = @(
        (Join-Path $root 'logs\main.log'),
        (Join-Path $root 'logs\main.log.1'),
        (Join-Path $root 'logs\api-errors.log'),
        (Join-Path $root 'logs\api-errors.log.1'),
        (Join-Path $root 'flo.db'),
        (Join-Path $root 'flo.db-wal'),
        (Join-Path $root 'flo.db-shm')
    )

    foreach ($file in $candidateFiles) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
        try {
            $item = Get-Item -LiteralPath $file -ErrorAction Stop
            $report.files += @{
                path = Get-SafePath $item.FullName
                size_bytes = $item.Length
                last_write_time = $item.LastWriteTime.ToString('o')
            }

            if ($item.Name -like 'main.log*' -or $item.Name -like 'api-errors.log*') {
                $tail = Get-Content -LiteralPath $file -Tail 250 -ErrorAction SilentlyContinue
                $safeTail = @($tail | ForEach-Object { ConvertTo-SafeText ([string]$_) })
                $outName = if ($item.Name -like 'main.log*') { 'main-log-tail.txt' } else { 'api-error-log-tail.txt' }
                $outPath = Join-Path $reportDir $outName
                if (Test-Path -LiteralPath $outPath) {
                    Add-Content -LiteralPath $outPath -Value ([Environment]::NewLine + "--- $($item.Name) from $(Get-SafePath $item.DirectoryName) ---")
                    Add-Content -LiteralPath $outPath -Value $safeTail
                } else {
                    Set-Content -LiteralPath $outPath -Value $safeTail -Encoding UTF8
                }
            }
        } catch { }
    }

    try {
        $drive = [System.IO.Path]::GetPathRoot($root).TrimEnd('\')
        $logicalDisk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$drive'"
        if ($logicalDisk) {
            $report.disk += @{
                drive = $drive
                size_bytes = $logicalDisk.Size
                free_bytes = $logicalDisk.FreeSpace
            }
        }
    } catch { }
}

$report | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $reportDir 'diagnostics.json') -Encoding UTF8
@"
LyraPOS diagnostic report
Collected: $($report.collected_at)
Computer: $($report.computer_name)

Health:
$($report.health | ConvertTo-Json -Depth 5)

Port 3001:
$($report.port_3001 | ConvertTo-Json -Depth 5)

Report contents:
- diagnostics.json: app health, process/port information, disk and file metadata
- main-log-tail.txt: up to 250 recent lines per main.log file, with common secrets redacted
- api-error-log-tail.txt: up to 250 recent lines per API error log, with common secrets redacted

Database files were NOT copied or modified.
"@ | Set-Content -LiteralPath (Join-Path $reportDir 'README.txt') -Encoding UTF8

$zipPath = Join-Path $env:USERPROFILE "Desktop\LyraPOS-Diagnostics-$timestamp.zip"
try {
    Compress-Archive -Path (Join-Path $reportDir '*') -DestinationPath $zipPath -Force
    Write-Host ''
    Write-Host 'LyraPOS diagnostics report created:' -ForegroundColor Green
    Write-Host $zipPath -ForegroundColor Cyan
} catch {
    Write-Host "Report folder created at: $reportDir" -ForegroundColor Yellow
    Write-Host "ZIP creation failed: $($_.Exception.Message)" -ForegroundColor Red
}
