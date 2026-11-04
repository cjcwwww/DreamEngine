#!/usr/bin/env node
/* ============================================================
 * build_release.mjs —— 打出可分发的安装包
 *
 * 目标：别人拿到这个包，装完就能用——预览已经在包里，
 * 不用在自己机器上慢慢渲染几百个效果。
 *
 * 产物：dist/DreamEngine-<版本>.zip
 *   DreamEngine/
 *     extension/          CEP 扩展本体（cep/com.dreamengine.panel 的内容）
 *     l1/                预生成预览（manifest.json + names.json + thumbs/）
 *     install.ps1        一键安装（建 Junction + 放开未签名扩展 + 部署 L1）
 *     README.md          安装与使用说明
 *
 * 用法：node tools/build_release.mjs
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync, statSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, "..");
const PANEL = resolve(ROOT, "cep/com.dreamengine.panel");
const L1 = resolve(ROOT, "dist/L1");
const STAGE = resolve(ROOT, "dist/stage");

const version = (() => {
  const text = readFileSync(resolve(ROOT, "cep/com.dreamengine.panel/CSXS/manifest.xml"), "utf8");
  const m = text.match(/ExtensionBundleVersion="([^"]+)"/);
  return m ? m[1] : "0.0.0";
})();

if (!existsSync(resolve(L1, "manifest.json"))) {
  console.error("找不到 L1 包，先跑 node tools/package_l1.mjs");
  process.exit(1);
}

/* ---------- 暂存目录 ---------- */
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(resolve(STAGE, "DreamEngine/extension"), { recursive: true });
mkdirSync(resolve(STAGE, "DreamEngine/l1"), { recursive: true });

/* 扩展本体：不要把开发期的大文件带进去 */
const EXT_SKIP = new Set(["data/thumbs"]);
for (const entry of readdirSync(PANEL, { withFileTypes: true })) {
  const rel = entry.name;
  if (EXT_SKIP.has(rel)) continue;
  cpSync(resolve(PANEL, rel), resolve(STAGE, "DreamEngine/extension", rel), {
    recursive: true,
  });
}

/* L1 预生成预览 */
cpSync(resolve(L1, "manifest.json"), resolve(STAGE, "DreamEngine/l1/manifest.json"));
cpSync(resolve(L1, "names.json"), resolve(STAGE, "DreamEngine/l1/names.json"));
if (existsSync(resolve(L1, "previews.tsv"))) {
  cpSync(resolve(L1, "previews.tsv"), resolve(STAGE, "DreamEngine/l1/previews.tsv"));
}
cpSync(resolve(L1, "thumbs"), resolve(STAGE, "DreamEngine/l1/thumbs"), { recursive: true });

/* ---------- 安装脚本 ---------- */
const installPs1 = `# DreamEngine 安装脚本（Windows / After Effects 2021+）
# 用法：右键本文件 →「使用 PowerShell 运行」，或在 PowerShell 里执行：
#   powershell -ExecutionPolicy Bypass -File .\\install.ps1

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "== DreamEngine 安装 ==" -ForegroundColor Cyan

# 1. 找 AE 的 CEP 扩展目录（按版本从小到大找）
$cepRoot = $null
foreach ($v in 11..14) {
  $p = Join-Path $env:APPDATA "Adobe\\CEP\\extensions"
  if (Test-Path $p) { $cepRoot = $p; break }
}
if (-not $cepRoot) {
  $cepRoot = Join-Path $env:APPDATA "Adobe\\CEP\\extensions"
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
Copy-Item -Force (Join-Path $here "l1\\manifest.json") (Join-Path $dataDir "manifest.json")
Copy-Item -Force (Join-Path $here "l1\\names.json") (Join-Path $dataDir "names.json")
if (Test-Path (Join-Path $here "l1\\previews.tsv")) {
  Copy-Item -Force (Join-Path $here "l1\\previews.tsv") (Join-Path $dataDir "previews.tsv")
}
Copy-Item -Force (Join-Path $here "l1\\thumbs\\*") (Join-Path $dataDir "thumbs")
Write-Host "L1 预览已部署：$((Get-ChildItem (Join-Path $dataDir 'thumbs')).Count) 张图"

# 4. 放开未签名扩展（CEP 11+ 需要 PlayerDebugMode）
$regPath = "HKCU:\\Software\\Adobe\\CSXS.11"
if (-not (Test-Path $regPath)) {
  New-Item -Path $regPath -Force | Out-Null
}
New-ItemProperty -Path $regPath -Name "PlayerDebugMode" -Value "1" -PropertyType String -Force | Out-Null
Write-Host "已开启 CEP 调试模式（允许加载未签名扩展）"

Write-Host ""
Write-Host "安装完成。请启动 After Effects，" -ForegroundColor Green
Write-Host "在 AE 菜单里打开：窗口 > 扩展 > DreamEngine"
`;
writeFileSync(resolve(STAGE, "DreamEngine/install.ps1"), installPs1, "utf8");

/* ---------- 说明文档 ---------- */
const l1Manifest = JSON.parse(readFileSync(resolve(L1, "manifest.json"), "utf8"));
const l1Count = l1Manifest.items.length;
const l1Animated = l1Manifest.items.filter((i) => (i.frames || 1) > 1).length;

const readme = `# DreamEngine ${version}

After Effects 效果可视化面板：浏览本机已安装的效果，每个带真实预览缩略图，
悬停可以看到效果动态施加的过程。

## 安装

1. 解压本包
2. 右键 \`install.ps1\` → 「使用 PowerShell 运行」
   （或在 PowerShell 里执行 \`powershell -ExecutionPolicy Bypass -File .\\install.ps1\`）
3. 启动 After Effects，菜单里打开 **窗口 > 扩展 > DreamEngine**

安装脚本会做三件事：把扩展装到 CEP 扩展目录、部署随包附带的预生成预览
（所以不用等渲染）、打开 CEP 调试模式以允许加载未签名扩展。

## 随包附带的内容

| 内容 | 说明 |
|---|---|
| \`l1/\` | 预生成预览：**${l1Count} 条效果**（其中 ${l1Animated} 条带动画），装完即可用 |
| \`extension/\` | 扩展本体 |
| \`install.ps1\` | 一键安装 |

## 需要自己渲的部分

包外的效果（你机器上装的三方插件、或者包生成之后 AE 新增的效果）没有预览。
面板里点「生成缺失预览」会按需补渲——本机效果会实时读取，
所以**别人装的 AE 上效果不同是正常的**。

## 已知限制

- 目前只在 After Effects 2021 实机验证过
- 少数效果在渲染时会拖死 AE，已在代码里排除
- Lumetri 颜色用饱和度调整代替演示（真渲会崩）
`;
writeFileSync(resolve(STAGE, "DreamEngine/README.md"), readme, "utf8");

/* ---------- 打包 ---------- */
const zipPath = resolve(ROOT, `dist/DreamEngine-${version}.zip`);
rmSync(zipPath, { force: true });
try {
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${resolve(STAGE, "DreamEngine")}' -DestinationPath '${zipPath}' -Force`,
    ],
    { stdio: "pipe" },
  );
} catch (e) {
  console.error("打包失败：" + String(e.message || e));
  process.exit(1);
}

const size = statSync(zipPath).size;
console.log(`安装包已生成：dist/DreamEngine-${version}.zip（${(size / 1024 / 1024).toFixed(2)} MB）`);
console.log(`  扩展本体 + L1 预览 + 安装脚本 + 说明`);
