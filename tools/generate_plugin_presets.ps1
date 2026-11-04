# ============================================================
# DreamEngine —— 一键生成「含第三方插件的预设」预览
#
# 纯 Windows 内置 PowerShell，不需要 Node / Python / 任何额外安装。
# 自动完成：温和关闭 AE -> 逐条隔离渲染（崩溃自动跳过）-> 重新打开 AE。
# 用法：双击同目录的 bat，或执行：
#   -File .\generate_plugin_presets.ps1
# ============================================================
param(
  [string]$Background = "",
  [int]$Limit = 12,
  [int]$Rounds = 40,
  [int]$Timeout = 240,
  [string]$AE = "",
  [switch]$Force,
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ext  = Join-Path $env:APPDATA "Adobe\CEP\extensions\com.dreamengine.panel"
$data = Join-Path $ext "data"
$probe = Join-Path $env:USERPROFILE "Documents\DreamEngineProbe"
$presets = Join-Path $env:USERPROFILE "Documents\DreamEngine\presets"

$todoPath        = Join-Path $probe "next_preset_plugin_batch.tsv"
$bgPath          = Join-Path $probe "preset_plugin_background.txt"
$logPath         = Join-Path $probe "preset_plugin_run.log"
$entriesPath     = Join-Path $probe "preset_plugin_previews.tsv"
$blacklistPath   = Join-Path $probe "preset_plugin_blacklist.tsv"
$pluginIndexPath = Join-Path $data "preset_plugin_manifest.json"
$panelIndexPath  = Join-Path $data "preset_manifest.json"

$jsx = Join-Path $here "run_plugin_preset_preview.jsx"
if (-not (Test-Path $jsx)) { $jsx = Join-Path $ext "tools\run_plugin_preset_preview.jsx" }

$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-Utf8($path, $text) {
  [System.IO.File]::WriteAllText($path, $text, $utf8)
}
function Read-Lines($path) {
  if (-not (Test-Path $path)) { return @() }
  return @(Get-Content $path -Encoding UTF8 | Where-Object { $_.Trim() -ne "" })
}

# ---------- 定位 AfterFX.exe ----------
if (-not $AE) {
  $adobeRoot = Join-Path ${env:ProgramFiles} "Adobe"
  if (Test-Path $adobeRoot) {
    $dirs = @(Get-ChildItem $adobeRoot -Directory -ErrorAction SilentlyContinue |
              Where-Object { $_.Name -like "Adobe After Effects*" } | Sort-Object Name)
    foreach ($d in $dirs) {
      $cand = Join-Path $d.FullName "Support Files\AfterFX.exe"
      if (Test-Path $cand) { $AE = $cand }
    }
  }
}
if (-not $AE -or -not (Test-Path $AE)) {
  Write-Host "[错误] 找不到 AfterFX.exe，请用 -AE 参数指定完整路径。" -ForegroundColor Red
  exit 1
}
if (-not (Test-Path $jsx)) {
  Write-Host "[错误] 找不到离线渲染脚本：$jsx" -ForegroundColor Red
  exit 1
}
if (-not (Test-Path $ext)) {
  Write-Host "[错误] 没找到已安装的 DreamEngine 扩展：$ext" -ForegroundColor Red
  Write-Host "请先运行安装包里的安装脚本。"
  exit 1
}
if (-not (Test-Path $probe)) { New-Item -ItemType Directory -Force -Path $probe | Out-Null }
if (-not (Test-Path $presets)) {
  Write-Host "[提示] 预设库还是空的：$presets" -ForegroundColor Yellow
  Write-Host "请先在面板的「预设预览」里添加 .ffx 文件。"
  exit 0
}

# ---------- 背景：未指定就跟随面板最后一次用的 ----------
if (-not $Background) {
  if (Test-Path $panelIndexPath) {
    try {
      $j = Get-Content $panelIndexPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $last = @($j.items) | Select-Object -Last 1
      if ($last.background) { $Background = $last.background }
    } catch {}
  }
  if (-not $Background) { $Background = "photo" }
}

# ---------- 从 TSV 生成面板读的独立索引（无 BOM，浏览器才能 JSON.parse）----------
function Build-PluginIndex {
  $items = @()
  foreach ($line in (Read-Lines $entriesPath)) {
    if ($line.StartsWith("#")) { continue }
    $r = $line -split "`t"
    if ($r.Count -lt 9) { continue }
    [int]$sheet = 0
    if (-not [int]::TryParse($r[2], [ref]$sheet)) { continue }
    $base = "preset_{0:D3}" -f $sheet
    $plugins = @($r[8].Split(",") | Where-Object { $_ } | Select-Object -Unique)
    $items += [ordered]@{
      name = $r[0]
      path = $r[1]
      sheet = $sheet
      src = "thumbs/" + $base + "_0000.png"
      frameSrc = "thumbs/" + $base + "_%04d.png"
      frames = [int]$r[3]
      animated = ($r[4] -eq "true")
      keyStart = [double]$r[5]
      keyEnd = [double]$r[6]
      background = $r[7]
      plugins = $plugins
      plugin = $true
      sliceColumns = 1
      sliceCellSize = 128
      sliceWidth = 128
      sliceHeight = 128
      x = 0
      y = 0
      width = 128
      height = 128
    }
  }
  $json = ([ordered]@{ version = 1; items = $items }) | ConvertTo-Json -Depth 6
  Write-Utf8 $pluginIndexPath $json
  return $items.Count
}

# ---------- 安全：温和关闭 AE（绝不强制结束，不丢未保存工程）----------
$closedByTool = $false
$running = @(Get-Process -Name AfterFX -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Write-Host ""
  Write-Host "检测到 After Effects 正在运行。" -ForegroundColor Yellow
  Write-Host "插件渲染必须在专用 AE 实例里做，所以需要暂时关闭当前 AE。"
  Write-Host "请先保存好工程；本工具不会强制结束 AE，也不会丢弃未保存内容。"
  Write-Host ""
  Write-Host "保存完成后按回车继续（按 Ctrl+C 可取消）..." -ForegroundColor Cyan
  Read-Host | Out-Null
  foreach ($p in $running) { try { $p.CloseMainWindow() | Out-Null } catch {} }
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    if (@(Get-Process -Name AfterFX -ErrorAction SilentlyContinue).Count -eq 0) { break }
  }
  if (@(Get-Process -Name AfterFX -ErrorAction SilentlyContinue).Count -gt 0) {
    Write-Host "[中止] AE 仍未退出（可能在等你确认保存）。请手动关闭后重新运行本工具。" -ForegroundColor Red
    exit 1
  }
  $closedByTool = $true
}

Write-Host ""
Write-Host "== DreamEngine 插件预设预览 ==" -ForegroundColor Cyan
Write-Host "AE      : $AE"
Write-Host "背景    : $Background"
Write-Host "预设库  : $presets"
Write-Host ""

$totalOk = 0
$totalFail = 0

for ($round = 1; $round -le $Rounds; $round++) {
  # 等上一轮的专用实例完全退出
  if (@(Get-Process -Name AfterFX -ErrorAction SilentlyContinue).Count -gt 0) {
    for ($i = 0; $i -lt 8; $i++) {
      Start-Sleep -Seconds 2
      if (@(Get-Process -Name AfterFX -ErrorAction SilentlyContinue).Count -eq 0) { break }
    }
    if (@(Get-Process -Name AfterFX -ErrorAction SilentlyContinue).Count -gt 0) {
      # 走到这里说明是本工具启动的专用实例，结束它是安全的
      Get-Process -Name AfterFX -ErrorAction SilentlyContinue | Stop-Process -Force
      Start-Sleep -Seconds 2
    }
  }

  # 已完成 / 崩溃黑名单 / 面板已生成
  $done = @{}
  foreach ($line in (Read-Lines $entriesPath)) {
    if ($line.StartsWith("#")) { continue }
    $r = $line -split "`t"
    if ($r.Count -ge 3 -and $r[1]) { $done[$r[1]] = $true }
  }
  $black = @{}
  foreach ($line in (Read-Lines $blacklistPath)) {
    $r = $line -split "`t"
    if ($r[0] -and $r[0] -ne "matchName") { $black[$r[0]] = $true }
  }
  $panelDone = @{}
  if (-not $Force -and (Test-Path $panelIndexPath)) {
    try {
      $j = Get-Content $panelIndexPath -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($it in @($j.items)) {
        if ($it.path) { $panelDone[$it.path.Replace('\','/')] = $true }
      }
    } catch {}
  }

  $all = @(Get-ChildItem $presets -Recurse -File -Filter *.ffx -ErrorAction SilentlyContinue |
           ForEach-Object { $_.FullName.Replace('\','/') } | Sort-Object)
  $cands = @($all | Where-Object {
    -not $done.ContainsKey($_) -and -not $black.ContainsKey($_) -and -not $panelDone.ContainsKey($_)
  })
  if ($cands.Count -eq 0) {
    $count = Build-PluginIndex
    Write-Host "没有待生成的预设了，索引共 $count 条。" -ForegroundColor Green
    break
  }

  $batch = @($cands | Select-Object -First $Limit)
  Write-Utf8 $todoPath (($batch -join "`n") + "`n")
  Write-Utf8 $bgPath $Background
  $before = @(Read-Lines $logPath).Count
  Write-Host "第 $round 轮：本次 $($batch.Count) 条，剩余 $($cands.Count) 条 ..."

  $proc = Start-Process -FilePath $AE -ArgumentList @('-r', ('"' + $jsx + '"')) -PassThru
  $startAt = Get-Date
  $crashed = $false
  while ($true) {
    Start-Sleep -Seconds 4
    $lines = @(Read-Lines $logPath)
    if ($lines.Count -gt $before -and $lines[-1].StartsWith("RESULT")) { break }
    if ($proc.HasExited) { $crashed = $true; break }
    if (((Get-Date) - $startAt).TotalSeconds -gt $Timeout) {
      Write-Host "  本轮超时，结束专用 AE 实例 ..." -ForegroundColor Yellow
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
      break
    }
  }

  $fresh = @(Read-Lines $logPath) | Select-Object -Skip $before
  $ok = @($fresh | Where-Object { $_.StartsWith("OK|") }).Count
  $fail = @($fresh | Where-Object { $_.StartsWith("FAIL|") }).Count
  $totalOk += $ok
  $totalFail += $fail
  $indexed = Build-PluginIndex
  $note = if ($crashed) { "（AE 进程消失，下一轮会自动拉黑元凶）" } else { "" }
  Write-Host "  成功 $ok，失败 $fail，索引累计 $indexed 条$note"
  if ($ok -eq 0 -and $fail -eq 0) {
    Write-Host "  本轮没有产出，停止以免空转。请查看日志：$logPath" -ForegroundColor Yellow
    break
  }
}

Write-Host ""
Write-Host "完成：成功 $totalOk，失败 $totalFail" -ForegroundColor Green
Write-Host "索引：$pluginIndexPath"
Write-Host "日志：$logPath"
if ($closedByTool -and -not $NoRestart) {
  Write-Host "正在重新打开 After Effects ..." -ForegroundColor Cyan
  Start-Process -FilePath $AE | Out-Null
  Write-Host "请打开刚才的工程，并关闭重开 DreamEngine 面板即可看到新预览。"
} else {
  Write-Host "启动 AE、关闭再重开 DreamEngine 面板即可看到新预览。"
}
