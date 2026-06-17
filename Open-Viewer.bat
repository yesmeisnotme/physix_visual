@echo off
setlocal
cd /d "%~dp0"
title PhysX Collision Visualizer

echo.
echo Starting PhysX Collision Visualizer...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo.
  echo [ERROR] Launch failed with exit code %EXITCODE%.
  echo.
  pause
)

endlocal
