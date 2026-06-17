# Ensures portable runtime dependencies (Node.js, VC++ redist, viewer npm, converter).
# Dot-sourced by start.ps1. Can also run: .\scripts\bootstrap.ps1

param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [switch]$SkipVCRedist
)

$ErrorActionPreference = "Stop"

$script:RuntimeRoot = Join-Path $Root "runtime"
$script:PortableNodeDir = Join-Path $RuntimeRoot "node"
$script:PortableNodeExe = Join-Path $PortableNodeDir "node.exe"
$script:PortableNpmCmd = Join-Path $PortableNodeDir "npm.cmd"
$script:NodeVersion = "22.13.1"
$script:VCRedistUrl = "https://aka.ms/vs/17/release/vc_redist.x64.exe"

function Write-BootStep {
    param([string]$Message, [ConsoleColor]$Color = [ConsoleColor]::Yellow)
    Write-Host $Message -ForegroundColor $Color
}

function Enable-Tls12 {
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    } catch {
        # Ignore on newer PowerShell / .NET
    }
}

function Test-VCRedistInstalled {
    $keys = @(
        "HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64"
    )
    foreach ($key in $keys) {
        $props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
        if ($props -and $props.Installed -eq 1) {
            return $true
        }
    }
    return $false
}

function Get-VCRedistInstallerPath {
    $dir = Join-Path $RuntimeRoot "vcredist"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    return Join-Path $dir "vc_redist.x64.exe"
}

function Install-VCRedist {
    $installer = Get-VCRedistInstallerPath
    if (-not (Test-Path $installer)) {
        Write-BootStep "  Downloading VC++ 2015-2022 x64 redistributable..."
        Enable-Tls12
        Invoke-WebRequest -Uri $VCRedistUrl -OutFile $installer -UseBasicParsing
    }

    Write-BootStep "  Installing VC++ runtime (may prompt for admin)..."
    $proc = Start-Process -FilePath $installer -ArgumentList @("/install", "/quiet", "/norestart") -Wait -PassThru
    if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 1638 -and $proc.ExitCode -ne 3010) {
        throw "VC++ install failed (exit $($proc.ExitCode)). Install manually: $VCRedistUrl"
    }
}

function Install-PortableNode {
    New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
    $dlDir = Join-Path $RuntimeRoot "downloads"
    New-Item -ItemType Directory -Force -Path $dlDir | Out-Null

    $zipName = "node-v$NodeVersion-win-x64.zip"
    $zipPath = Join-Path $dlDir $zipName
    $url = "https://nodejs.org/dist/v$NodeVersion/$zipName"

    Write-BootStep "  Downloading Node.js v$NodeVersion portable..."
    Enable-Tls12
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing

    $extractDir = Join-Path $dlDir "node-extract"
    if (Test-Path $extractDir) {
        Remove-Item -Recurse -Force $extractDir
    }
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

    $extracted = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
    if (-not $extracted) {
        throw "Node.js archive extract failed"
    }

    if (Test-Path $PortableNodeDir) {
        Remove-Item -Recurse -Force $PortableNodeDir
    }
    Move-Item -Path $extracted.FullName -Destination $PortableNodeDir
    Write-BootStep "  Node.js ready at runtime\node" ([ConsoleColor]::Green)
}

function Resolve-NodeRuntime {
    if (Test-Path $PortableNodeExe) {
        return @{
            NodeExe = $PortableNodeExe
            NpmCmd  = $PortableNpmCmd
            NodeDir = $PortableNodeDir
            Source  = "bundled"
        }
    }

    $sysNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($sysNode) {
        $nodeDir = Split-Path $sysNode.Source -Parent
        $npmCmd = Join-Path $nodeDir "npm.cmd"
        if (-not (Test-Path $npmCmd)) {
            $npmCmd = "npm.cmd"
        }
        return @{
            NodeExe = $sysNode.Source
            NpmCmd  = $npmCmd
            NodeDir = $nodeDir
            Source  = "system"
        }
    }

    Write-BootStep "[deps] Node.js not found; downloading portable runtime..."
    Install-PortableNode
    return @{
        NodeExe = $PortableNodeExe
        NpmCmd  = $PortableNpmCmd
        NodeDir = $PortableNodeDir
        Source  = "downloaded"
    }
}

function Test-ConverterRunnable {
    param([string]$ExePath)

    if (-not (Test-Path $ExePath)) {
        return @{ Ok = $false; Error = "missing" }
    }

    $dir = Split-Path $ExePath -Parent
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $ExePath
    $psi.Arguments = "--help"
    $psi.WorkingDirectory = $dir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
        if (-not $proc.WaitForExit(15000)) {
            $proc.Kill()
            return @{ Ok = $false; Error = "timeout" }
        }
        if ($proc.ExitCode -eq 0) {
            return @{ Ok = $true }
        }
        $stderr = $proc.StandardError.ReadToEnd()
        return @{ Ok = $false; Error = $stderr.Trim() }
    } catch {
        return @{ Ok = $false; Error = $_.Exception.Message }
    }
}

function Ensure-Converter {
    param([string]$ConverterPath)

    $check = Test-ConverterRunnable -ExePath $ConverterPath
    if ($check.Ok) {
        return
    }

    if ($check.Error -eq "missing") {
        $physxHeader = Join-Path $Root "third_party\PhysX-3.4\PhysX_3.4\Include\PxPhysicsAPI.h"
        if (Test-Path $physxHeader) {
            Write-BootStep "[deps] Building converter (PhysX SDK found)..."
            Push-Location (Join-Path $Root "converter")
            cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release | Out-Host
            if ($LASTEXITCODE -ne 0) { Pop-Location; throw "cmake configure failed" }
            cmake --build build | Out-Host
            if ($LASTEXITCODE -ne 0) { Pop-Location; throw "cmake build failed" }
            Pop-Location
            $check = Test-ConverterRunnable -ExePath $ConverterPath
            if ($check.Ok) { return }
        }

        throw @"
Converter not found: $ConverterPath

Copy the entire converter\build folder (exe + DLLs) from a machine that already built it,
or install PhysX SDK under third_party and build locally.
"@
    }

    if (-not $SkipVCRedist) {
        Write-BootStep "[deps] Converter failed to start; checking VC++ runtime..."
        if (-not (Test-VCRedistInstalled)) {
            Install-VCRedist
            $check = Test-ConverterRunnable -ExePath $ConverterPath
            if ($check.Ok) { return }
        }
    }

    throw @"
Converter cannot run (missing DLL or runtime).

1. Ensure converter\build contains physix_convert.exe and all PhysX *.dll
2. Install VC++ 2015-2022 x64: $VCRedistUrl
   (bootstrap can also download it to runtime\vcredist\ on next run)

Detail: $($check.Error)
"@
}

function Ensure-ViewerNodeModules {
    param(
        [string]$ViewerDir,
        [string]$NpmCmd,
        [string]$NodeDir
    )

    if (Test-Path (Join-Path $ViewerDir "node_modules")) {
        return
    }

    Write-BootStep "[deps] Installing viewer npm packages (first run only)..."
    $prevPath = $env:PATH
    $env:PATH = "$NodeDir;$prevPath"
    try {
        Push-Location $ViewerDir
        & $NpmCmd install --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed (exit $LASTEXITCODE)"
        }
    } finally {
        Pop-Location
        $env:PATH = $prevPath
    }
}

function Invoke-Bootstrap {
    Write-BootStep "[deps] Checking runtime..."
    $node = Resolve-NodeRuntime
    Write-BootStep "  Node: $($node.Source) ($($node.NodeExe))" ([ConsoleColor]::Gray)

    $converter = Join-Path $Root "converter\build\physix_convert.exe"
    Ensure-Converter -ConverterPath $converter

    $viewer = Join-Path $Root "viewer"
    Ensure-ViewerNodeModules -ViewerDir $viewer -NpmCmd $node.NpmCmd -NodeDir $node.NodeDir

    return $node
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-Bootstrap | Out-Null
    Write-BootStep "Bootstrap OK." ([ConsoleColor]::Green)
}
