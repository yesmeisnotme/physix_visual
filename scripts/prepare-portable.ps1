# One-time prep before copying the folder to another PC (optional, for offline use).
# Downloads portable Node.js and ensures viewer npm + converter are ready.

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")

Write-Host ""
Write-Host "Prepare portable copy" -ForegroundColor Cyan
Write-Host "  Root: $Root"
Write-Host ""

. (Join-Path $PSScriptRoot "bootstrap.ps1") -Root $Root.Path

if (-not (Test-Path (Join-Path $Root "runtime\node\node.exe"))) {
    Write-Host "Downloading portable Node.js into runtime\node ..." -ForegroundColor Yellow
    Install-PortableNode
}

$node = Invoke-Bootstrap

Write-Host ""
Write-Host "Ready to copy. Include at minimum:" -ForegroundColor Green
Write-Host "  - converter\build\          (exe + DLLs)"
Write-Host "  - viewer\node_modules\"
Write-Host "  - runtime\node\             (portable Node, $($node.Source))"
Write-Host ""
Write-Host "Optional: runtime\vcredist\  (VC++ installer cache)"
Write-Host "Not needed on target: third_party\PhysX SDK, .git"
Write-Host ""
Write-Host "Target PC: double-click Open-Viewer.bat"
Write-Host ""
