param(
    [string]$Bin = "",
    [string]$AirWall = "",
    [string]$AirWallBinDir = "",
    [switch]$Pick,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Converter = Join-Path $Root "converter\build\physix_convert.exe"
$Viewer = Join-Path $Root "viewer"
$Port = 5173

. (Join-Path $PSScriptRoot "bootstrap.ps1") -Root $Root.Path

function Test-ServerReady([int]$PortNumber) {
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:$PortNumber/api/status" -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Stop-PortListener([int]$PortNumber) {
    try {
        $connections = Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction SilentlyContinue
        foreach ($conn in $connections) {
            if ($conn.OwningProcess -gt 0) {
                Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {
        # Get-NetTCPConnection may require admin; ignore and rely on strictPort
    }
}

Write-Host ""
Write-Host "PhysX Collision Visualizer" -ForegroundColor Cyan
Write-Host ""

$node = Invoke-Bootstrap

$InputPath = ""
$Url = "http://127.0.0.1:$Port/"

if ($Pick) {
    Write-Host "[2/4] Optional: select collision.bin (Cancel to open viewer only)..." -ForegroundColor Yellow
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = "Select PhysX collision.bin (optional)"
    $dialog.Filter = "PhysX collision (*.bin)|*.bin|All files (*.*)|*.*"
    $defaultBin = Join-Path $Root "collision.bin"
    if (Test-Path $defaultBin) {
        $dialog.InitialDirectory = Split-Path $defaultBin -Parent
        $dialog.FileName = Split-Path $defaultBin -Leaf
    } else {
        $dialog.InitialDirectory = $Root
    }
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $InputPath = $dialog.FileName
    }
} elseif (-not [string]::IsNullOrWhiteSpace($Bin)) {
    $InputPath = $Bin
    if (-not (Test-Path $InputPath)) {
        throw "File not found: $InputPath"
    }
    Write-Host "[2/4] Will load in viewer: $InputPath" -ForegroundColor Gray
} else {
    Write-Host "[2/4] Opening viewer (load collision.bin from UI)" -ForegroundColor Gray
}

if ($InputPath -ne "") {
    $UrlBin = [uri]::EscapeDataString((Resolve-Path $InputPath).Path)
    $Url = "http://127.0.0.1:$Port/?bin=$UrlBin"
    if (-not [string]::IsNullOrWhiteSpace($AirWall)) {
        if (-not (Test-Path $AirWall)) {
            throw "AirWallTable not found: $AirWall"
        }
        $UrlAirWall = [uri]::EscapeDataString((Resolve-Path $AirWall).Path)
        $Url = "$Url&airwall=$UrlAirWall"
        if (-not [string]::IsNullOrWhiteSpace($AirWallBinDir)) {
            if (-not (Test-Path $AirWallBinDir)) {
                throw "AirWall bin directory not found: $AirWallBinDir"
            }
            $UrlAirWallBin = [uri]::EscapeDataString((Resolve-Path $AirWallBinDir).Path)
            $Url = "$Url&airwallbin=$UrlAirWallBin"
        }
    }
} elseif (-not [string]::IsNullOrWhiteSpace($AirWall)) {
    Write-Host "[2/4] AirWall parameter ignored because no -Bin was provided" -ForegroundColor Yellow
}

Push-Location $Viewer
$server = $null
$prevPath = $env:PATH
$env:PATH = "$($node.NodeDir);$prevPath"

try {
    if (Test-ServerReady $Port) {
        Write-Host "[3/4] Dev server already running on port $Port" -ForegroundColor Gray
    } else {
        Write-Host "[3/4] Starting dev server on port $Port..." -ForegroundColor Yellow
        Stop-PortListener $Port
        Start-Sleep -Milliseconds 300
        $server = Start-Process -FilePath $node.NpmCmd -ArgumentList "run", "dev" -WorkingDirectory $Viewer -PassThru -NoNewWindow
        $ready = $false
        for ($i = 0; $i -lt 60; $i++) {
            if (Test-ServerReady $Port) {
                $ready = $true
                break
            }
            if ($server.HasExited) {
                throw "Dev server exited unexpectedly. Check runtime\node or run: .\scripts\bootstrap.ps1"
            }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) {
            if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
            throw "Dev server did not start within 60s."
        }
    }

    Write-Host "[4/4] Ready" -ForegroundColor Green
    if ($InputPath -ne "") {
        Write-Host "  Source : $InputPath"
    }
    if (-not [string]::IsNullOrWhiteSpace($AirWall)) {
        Write-Host "  AirWall: $AirWall"
    }
    if (-not [string]::IsNullOrWhiteSpace($AirWallBinDir)) {
        Write-Host "  AirWall bin dir: $AirWallBinDir"
    }
    Write-Host "  Viewer : $Url"
    Write-Host "  Note   : load map / set guide & pivot in the browser UI"
    Write-Host ""

    if (-not $NoBrowser) {
        Start-Process $Url
    }

    if (-not (Test-ServerReady $Port)) {
        throw "Server is not responding"
    }

    if ($server -and -not $server.HasExited) {
        Wait-Process -Id $server.Id
    } else {
        Write-Host "Server is running in another process. Close that window to stop."
        Read-Host "Press Enter to exit"
    }
} finally {
    $env:PATH = $prevPath
    Pop-Location
}
