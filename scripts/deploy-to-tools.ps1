# Copy portable PhysX Visualizer into a Perforce Tools subtree (or any target folder).
# Usage:
#   .\scripts\deploy-to-tools.ps1
#   .\scripts\deploy-to-tools.ps1 -Target "E:\qsp4\TSGame_Depot\GameProject\Tools\PhysxVisual"

param(
    [string]$Target = "E:\qsp4\TSGame_Depot\GameProject\Tools\PhysxVisual"
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")

Write-Host ""
Write-Host "Deploy PhysX Visualizer (portable)" -ForegroundColor Cyan
Write-Host "  Source: $Root"
Write-Host "  Target: $Target"
Write-Host ""

. (Join-Path $PSScriptRoot "bootstrap.ps1") -Root $Root.Path | Out-Null
if (-not (Test-Path (Join-Path $Root "runtime\node\node.exe"))) {
    Write-Host "Downloading portable Node.js..." -ForegroundColor Yellow
    Install-PortableNode
}
Invoke-Bootstrap | Out-Null

$parent = Split-Path $Target -Parent
if (-not (Test-Path $parent)) {
    throw "Parent directory does not exist: $parent"
}
New-Item -ItemType Directory -Force -Path $Target | Out-Null

function Sync-Robocopy {
    param(
        [string]$Source,
        [string]$Dest,
        [string[]]$ExcludeDirs = @()
    )
    if (-not (Test-Path $Source)) {
        throw "Missing source: $Source"
    }
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    $args = @(
        $Source, $Dest,
        "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS", "/NP"
    )
    foreach ($dir in $ExcludeDirs) {
        $args += "/XD"
        $args += (Join-Path $Source $dir)
    }
    & robocopy @args | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8) {
        throw "robocopy failed ($code): $Source -> $Dest"
    }
}

# Root launchers + brief usage
Copy-Item -Path (Join-Path $Root "Open-Viewer.bat") -Destination (Join-Path $Target "Open-Viewer.bat") -Force
$cnBat = Get-ChildItem -LiteralPath $Root -Filter "*.bat" | Where-Object { $_.Name -ne "Open-Viewer.bat" }
foreach ($bat in $cnBat) {
    Copy-Item -LiteralPath $bat.FullName -Destination (Join-Path $Target $bat.Name) -Force
}

Sync-Robocopy -Source (Join-Path $Root "scripts") -Dest (Join-Path $Target "scripts")
Sync-Robocopy -Source (Join-Path $Root "runtime") -Dest (Join-Path $Target "runtime") -ExcludeDirs @("downloads")
Sync-Robocopy -Source (Join-Path $Root "converter\build") -Dest (Join-Path $Target "converter\build")

Sync-Robocopy -Source (Join-Path $Root "viewer") -Dest (Join-Path $Target "viewer") -ExcludeDirs @(".cache", "dist", "node_modules\.vite")

# Depot docs + p4 ignore (maintained in repo depot/)
$depotMeta = Join-Path $Root "depot"
if (Test-Path $depotMeta) {
    Copy-Item -Path (Join-Path $depotMeta ".p4ignore") -Destination (Join-Path $Target ".p4ignore") -Force
    Copy-Item -Path (Join-Path $depotMeta "P4DEPOT.md") -Destination (Join-Path $Target "P4DEPOT.md") -Force
}

$usage = @"
PhysX Collision Visualizer (portable)
=====================================

Double-click: Open-Viewer.bat

1. Browser opens automatically (http://127.0.0.1:5173/)
2. Click "Open collision.bin" or drag-drop a .bin file
3. Close the command window to stop the server

Requirements: Windows 10+ x64, Edge/Chrome.
First launch may install VC++ runtime (admin prompt possible).

Do NOT commit collision.bin or viewer\.cache to depot — see P4DEPOT.md and .p4ignore.

Built from physix_visual deploy script.
"@
Set-Content -Path (Join-Path $Target "USAGE.txt") -Value $usage -Encoding UTF8

Write-Host "Deploy complete." -ForegroundColor Green
Write-Host "  $Target"
Write-Host ""
Get-ChildItem $Target -Recurse -File | Measure-Object -Property Length -Sum | ForEach-Object {
    Write-Host ("  Files: {0}, Size: {1:N1} MB" -f $_.Count, ($_.Sum / 1MB))
}
Write-Host ""
Write-Host "Third party: double-click Open-Viewer.bat" -ForegroundColor Gray
Write-Host ""
