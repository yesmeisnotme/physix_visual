# 兼容旧脚本：请优先使用 scripts/start.ps1 或双击「打开碰撞可视化.bat」
param(
    [string]$Input = (Join-Path $PSScriptRoot "..\collision.bin"),
    [switch]$StatsOnly,
    [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Converter = Join-Path $Root "converter\build\physix_convert.exe"

if (-not (Test-Path $Converter)) {
    Write-Error "Converter not built. Run: cd converter; cmake -B build -G Ninja; cmake --build build"
}

if ($StatsOnly) {
    Push-Location (Split-Path $Converter)
    & $Converter -i $Input --stats-only
    $code = $LASTEXITCODE
    Pop-Location
    exit $code
}

$startArgs = @("-Bin", $Input)
if ($NoOpen) { $startArgs += "-NoBrowser" }
& (Join-Path $PSScriptRoot "start.ps1") @startArgs
