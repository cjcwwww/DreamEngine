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

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, statSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
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
/* 不用 rmSync 递归删目录：部分环境下 fs.rmSync 会被劫持到回收站并超时，
   失败时还会把旧包毁掉。改成手动逐层清空。 */
function emptyDir(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      emptyDir(full);
      rmdirSync(full);
    } else {
      unlinkSync(full);
    }
  }
}
emptyDir(STAGE);
mkdirSync(resolve(STAGE, "DreamEngine/extension"), { recursive: true });
mkdirSync(resolve(STAGE, "DreamEngine/l1"), { recursive: true });
mkdirSync(resolve(STAGE, "DreamEngine/tools"), { recursive: true });

/* 离线插件预设工具：纯 Windows PowerShell，用户机器上不需要 Node。
   这三个文件必须随包走 —— 否则别人装完根本没有生成插件预览的入口。
   bat 放在包根目录（解压一眼可见），ps1 与 jsx 放 tools/。 */
for (const name of ["generate_plugin_presets.ps1", "run_plugin_preset_preview.jsx"]) {
  cpSync(resolve(ROOT, "tools", name), resolve(STAGE, "DreamEngine/tools", name));
}
cpSync(
  resolve(ROOT, "tools", "生成插件预设预览.bat"),
  resolve(STAGE, "DreamEngine", "生成插件预设预览.bat"),
);

/* 扩展本体：不要把开发期的大文件带进去。
   排除规则必须按「相对面板根的路径」匹配。
   之前写成按顶层条目名匹配 "data/thumbs"，但顶层条目其实是 "data"，
   规则从未生效 —— 一张 2048 时代的遗留图被带进了分发包。 */
const EXT_SKIP = new Set(["data/thumbs", "data/manifest.json", "data/previews.tsv"]);
for (const entry of readdirSync(PANEL, { withFileTypes: true })) {
  const rel = entry.name;
  const relPath = entry.isDirectory() ? `${rel}/` : rel;
  if (EXT_SKIP.has(relPath) || EXT_SKIP.has(rel)) continue;
  cpSync(resolve(PANEL, rel), resolve(STAGE, "DreamEngine/extension", rel), {
    recursive: true,
  });
}
/* 递归清理：data/ 里可能还有嵌套的 thumbs 目录 */
{
  const dataDir = resolve(STAGE, "DreamEngine/extension/data");
  if (existsSync(dataDir)) {
    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
      if (entry.name === "thumbs") {
        emptyDir(resolve(dataDir, entry.name));
        rmdirSync(resolve(dataDir, entry.name));
      }
    }
  }
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

# 5. 离线插件预设工具也放进扩展目录（.ps1 与面板都能定位到）
$toolsTarget = Join-Path $target "tools"
New-Item -ItemType Directory -Force -Path $toolsTarget | Out-Null
Copy-Item -Force (Join-Path $here "tools\\*") $toolsTarget
Write-Host "离线插件预设工具已部署：$toolsTarget"

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
| \`tools/\` | 含插件预设的一键生成工具（纯 PowerShell，无需 Node） |

## 需要自己渲的部分

包外的效果（你机器上装的三方插件、或者包生成之后 AE 新增的效果）没有预览。
面板里点「生成缺失预览」会按需补渲——本机效果会实时读取，
所以**别人装的 AE 上效果不同是正常的**。

## 含第三方插件的预设预览（可选，一键）

你自己导入的 .ffx 如果用了 Sapphire / BCC / Magic Bullet 之类的插件效果，
**不能在面板里直接渲染** —— 多个插件效果混渲会让宿主 AE 进程崩溃，
而面板和 AE 是同一个进程。这类预览走随包附带的一键工具：

1. 在 AE 里**保存好当前工程**
2. 双击包根目录的 \`生成插件预设预览.bat\`
3. 按提示按回车：工具会自动温和关闭 AE、在专用实例里逐条隔离渲染、
   完成后重新打开 AE
4. 打开刚才的工程，关闭再重开 DreamEngine 面板，预览就出现了

工具只用 Windows 自带的 PowerShell，**不需要 Node / Python 或任何额外安装**，
也不会强制结束 AE（有未保存内容时 AE 会自己弹保存框，你随时可以取消）。
它会跳过已经生成过的预设，把崩溃的条目自动拉黑，随时可中断、下次接着跑。
换预览背景：先在面板「预设预览」里选好背景，工具会自动沿用。

## 已知限制

- 目前只在 After Effects 2021 实机验证过
- 少数效果在渲染时会拖死 AE，已在代码里排除
- Lumetri 颜色用饱和度调整代替演示（真渲会崩）
`;
writeFileSync(resolve(STAGE, "DreamEngine/README.md"), readme, "utf8");

/* ---------- 打包 ---------- */
const zipPath = resolve(ROOT, `dist/DreamEngine-${version}.zip`);
/* 用 Python 的 zipfile 打包，不用 PowerShell 的 Compress-Archive：
   后者在 Windows 上把条目名写成反斜杠（DreamEngine\extension\index.html），
   不符合 zip 规范（要求正斜杠）—— Windows 资源管理器能解，
   但 macOS/Linux 的解压工具与部分安装器会把整条路径当成一个文件名。 */
const zipScript = `
import os, sys, zipfile
stage, out = sys.argv[1], sys.argv[2]
root = os.path.join(stage, "DreamEngine")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, stage).replace(os.sep, "/")
            z.write(full, rel)
`;
const zipTmp = resolve(ROOT, ".workbuddy/zip_pack.py");
mkdirSync(resolve(ROOT, ".workbuddy"), { recursive: true });
writeFileSync(zipTmp, zipScript, "utf8");
try {
  execFileSync("python", [zipTmp, STAGE, zipPath], { stdio: "pipe" });
} catch (e) {
  console.error("打包失败：" + String(e.message || e));
  process.exit(1);
}

const size = statSync(zipPath).size;
console.log(`安装包已生成：dist/DreamEngine-${version}.zip（${(size / 1024 / 1024).toFixed(2)} MB）`);
console.log(`  扩展本体 + L1 预览 + 安装脚本 + 说明`);
