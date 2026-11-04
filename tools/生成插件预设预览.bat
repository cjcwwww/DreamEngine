@echo off
chcp 65001 >nul 2>&1
setlocal
title DreamEngine - Plugin Preset Previews
echo.
echo   DreamEngine : generate previews for presets with 3rd-party plugins
echo   Windows PowerShell only - no Node.js / Python required.
echo   It will temporarily CLOSE After Effects and reopen it when done.
echo   Please SAVE your project before pressing Enter in the next step.
echo.

rem In the release zip this bat sits at the package root and the script in tools\.
rem In a dev checkout both files sit in the same tools\ folder - support both.
set "PS1=%~dp0generate_plugin_presets.ps1"
if not exist "%PS1%" set "PS1=%~dp0tools\generate_plugin_presets.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
echo.
pause
