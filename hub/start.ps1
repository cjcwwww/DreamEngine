# DreamEngine Hub development launcher.
# The normal-integrity Electron process crashes in electron.exe on this machine
# (0xC0000005, before app ready); an elevated process and software rendering work.
# This script re-launches itself elevated, then starts Electron.
$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath) + $args
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList
    exit 0
}

Set-Location $PSScriptRoot
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$electron = Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe'
& $electron '.' '--disable-gpu' '--no-sandbox' @args
exit $LASTEXITCODE
