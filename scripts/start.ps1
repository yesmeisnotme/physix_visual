param(
    [string]$Bin = "",
    [switch]$Pick,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Converter = Join-Path $Root "converter\build\physix_convert.exe"
$Viewer = Join-Path $Root "viewer"
$Port = 5173

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

if (-not (Test-Path $Converter)) {
    Write-Host "[1/4] Building converter..." -ForegroundColor Yellow
    Push-Location (Join-Path $Root "converter")
    cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release | Out-Host
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "cmake configure failed" }
    cmake --build build | Out-Host
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "cmake build failed" }
    Pop-Location
    if (-not (Test-Path $Converter)) {
        throw "Converter not found. Run: cd converter; cmake -B build -G Ninja; cmake --build build"
    }
}

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
}

Push-Location $Viewer
$server = $null

if (-not (Test-Path "node_modules")) {
    Write-Host "[3/4] Installing viewer dependencies (npm install)..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm install failed" }
}

if (Test-ServerReady $Port) {
    Write-Host "[3/4] Dev server already running on port $Port" -ForegroundColor Gray
} else {
    Write-Host "[3/4] Starting dev server on port $Port..." -ForegroundColor Yellow
    Stop-PortListener $Port
    Start-Sleep -Milliseconds 300
    $server = Start-Process -FilePath "npm.cmd" -ArgumentList "run", "dev" -WorkingDirectory $Viewer -PassThru -NoNewWindow
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        if (Test-ServerReady $Port) {
            $ready = $true
            break
        }
        if ($server.HasExited) {
            Pop-Location
            throw "Dev server exited unexpectedly. Check Node.js and run: cd viewer; npm run dev"
        }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
        Pop-Location
        throw "Dev server did not start within 60s. Check Node.js is installed."
    }
}

$Url = "http://127.0.0.1:$Port/?bin=$UrlBin"

Write-Host "[4/4] Ready" -ForegroundColor Green
if ($InputPath -ne "") {
    Write-Host "  Source : $InputPath"
}
Write-Host "  Viewer : $Url"
Write-Host "  Note   : load map / set guide & pivot in the browser UI"
Write-Host ""

if (-not $NoBrowser) {
    Start-Process $Url
}

if (-not (Test-ServerReady $Port)) {
    Pop-Location
    throw "Server is not responding"
}

# Keep this window attached to vite output if we started the server here
if ($server -and -not $server.HasExited) {
    Wait-Process -Id $server.Id
} else {
    Write-Host "Server is running in another process. Close that window to stop."
    Read-Host "Press Enter to exit"
}

Pop-Location
