@echo off
chcp 65001 >nul 2>&1
setlocal
title DreamEngine - Plugin Preset Previews
echo.
echo   DreamEngine : generate previews for presets with 3rd-party plugins
echo   Windows PowerShell only - no Node.js / Python required.
echo.
echo   STEP 1  Save your project, then CLOSE After Effects yourself.
echo   STEP 2  This tool detects AE has exited and starts rendering
echo           in a private instance (crash-loop protected).
echo   STEP 3  After Effects is reopened when rendering finishes.
echo.
echo   It never force-closes AE and never discards unsaved work.
echo.

rem In the release zip this bat sits at the package root and the script in tools\.
rem In a dev checkout both files sit in the same tools\ folder - support both.
set "PS1=%~dp0generate_plugin_presets.ps1"
if not exist "%PS1%" set "PS1=%~dp0tools\generate_plugin_presets.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
echo.
pause
