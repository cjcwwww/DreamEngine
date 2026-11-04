/* ============================================================
 * ae.js —— 定位 After Effects、判断它是否在运行
 *
 * 和 generate_plugin_presets.ps1 里的做法保持一致：
 * 扫 Program Files 下的 "Adobe After Effects *"，取版本号最大的那个
 * （app.path 在 AE 2021 上是 undefined，这条是 M0 实测结论）。
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * @returns {{name: string, exe: string, version: string}[]} 按版本升序
 */
function findAfterFX() {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
  const found = [];

  for (const root of roots) {
    const adobe = path.join(root, "Adobe");
    let entries;
    try {
      entries = fs.readdirSync(adobe, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^Adobe After Effects/i.test(entry.name)) continue;
      const exe = path.join(adobe, entry.name, "Support Files", "AfterFX.exe");
      if (!fs.existsSync(exe)) continue;
      const version = (entry.name.match(/(\d{4})/) || [, "0"])[1];
      found.push({ name: entry.name, exe, version });
    }
  }

  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

/** 最新可用的 AfterFX.exe 绝对路径，找不到返回 "" */
function bestAfterFX() {
  const all = findAfterFX();
  return all.length ? all[all.length - 1].exe : "";
}

/**
 * AE 是否正在运行。
 * 渲染要求「用户先关闭 AE」，Hub 靠它决定按钮是提示还是直接开跑。
 */
function isAERunning() {
  try {
    const out = execFileSync(
      "tasklist",
      ["/FI", "IMAGENAME eq AfterFX.exe", "/NH"],
      { encoding: "utf8", windowsHide: true, timeout: 5000 },
    );
    return /AfterFX\.exe/i.test(out);
  } catch {
    return false;
  }
}

module.exports = { findAfterFX, bestAfterFX, isAERunning };
