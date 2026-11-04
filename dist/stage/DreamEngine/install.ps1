# DreamEngine 安装脚本（Windows / After Effects 2021+）
# 用法：右键本文件 →「使用 PowerShell 运行」，或在 PowerShell 里执行：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "== DreamEngine 安装 ==" -ForegroundColor Cyan

# 1. 找 AE 的 CEP 扩展目录（按版本从小到大找）
$cepRoot = $null
foreach ($v in 11..14) {
  $p = Join-Path $env:APPDATA "Adobe\CEP\extensions"
  if (Test-Path $p) { $cepRoot = $p; break }
}
if (-not $cepRoot) {
  $cepRoot = Join-Path $env:APPDATA "Adobe\CEP\extensions"
  New-Item -ItemType Directory -Force -Path $cepRoot | Out-Null
}
$target = Join-Path $cepRoot "com.dreamengine.panel"
Write-Host "扩展目录：$target"

# 2. 部署扩展本体（先清掉旧的）
if (Test-Path $target) {
  Write-Host "移除旧版本…"
  Remove-Item -Recurse -Force $target
}
Copy-Item -Recurse -Force (Join-Path $here "extension") $target

# 3. 部署 L1 预生成预览（这样打开面板就有图，不用自己渲染）
$dataDir = Join-Path $target "data"
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir "thumbs") | Out-Null
Copy-Item -Force (Join-Path $here "l1\manifest.json") (Join-Path $dataDir "manifest.json")
Copy-Item -Force (Join-Path $here "l1\names.json") (Join-Path $dataDir "names.json")
if (Test-Path (Join-Path $here "l1\previews.tsv")) {
  Copy-Item -Force (Join-Path $here "l1\previews.tsv") (Join-Path $dataDir "previews.tsv")
}
Copy-Item -Force (Join-Path $here "l1\thumbs\*") (Join-Path $dataDir "thumbs")
Write-Host "L1 预览已部署：$((Get-ChildItem (Join-Path $dataDir 'thumbs')).Count) 张图"

# 4. 放开未签名扩展（CEP 11+ 需要 PlayerDebugMode）
$regPath = "HKCU:\Software\Adobe\CSXS.11"
if (-not (Test-Path $regPath)) {
  New-Item -Path $regPath -Force | Out-Null
}
New-ItemProperty -Path $regPath -Name "PlayerDebugMode" -Value "1" -PropertyType String -Force | Out-Null
Write-Host "已开启 CEP 调试模式（允许加载未签名扩展）"

Write-Host ""
Write-Host "安装完成。请启动 After Effects，" -ForegroundColor Green
Write-Host "在 AE 菜单里打开：窗口 > 扩展 > DreamEngine"
