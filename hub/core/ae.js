/* ============================================================
 * ae.js —— 定位 After Effects、判断它是否在运行
 *
 * 优先读取 Windows 的 App Paths 注册项，再扫描各磁盘的常见 Program Files
 * 目录。App Paths 由 AE 安装器写入，因此能覆盖安装在 D:/E: 等非默认盘的情况。
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * @returns {{name: string, exe: string, version: string}[]} 按版本升序
 */
const REGISTRY_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AfterFX.exe",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AfterFX.exe",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AfterFX.exe",
  "HKCU\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AfterFX.exe",
];
let registryCache = { at: 0, paths: [] };

function registeredAfterFXPaths() {
  if (Date.now() - registryCache.at < 30000) return registryCache.paths;
  const paths = [];
  for (const key of REGISTRY_KEYS) {
    let output;
    try {
      output = execFileSync("reg.exe", ["query", key, "/ve"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      continue;
    }
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/REG_SZ\s+(.+?)\s*$/i);
      if (!match) continue;
      const candidate = match[1].replace(/^"|"$/g, "").replace(/,\d+$/, "");
      if (!/AfterFX\.exe$/i.test(candidate) || !fs.existsSync(candidate)) continue;
      paths.push(candidate);
    }
  }
  registryCache = { at: Date.now(), paths: [...new Set(paths)] };
  return registryCache.paths;
}

function defaultRoots() {
  const roots = new Set(
    [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432]
      .filter(Boolean),
  );
  for (let code = "C".charCodeAt(0); code <= "Z".charCodeAt(0); code++) {
    const drive = String.fromCharCode(code) + ":\\";
    if (!fs.existsSync(drive)) continue;
    roots.add(path.join(drive, "Program Files"));
    roots.add(path.join(drive, "Program Files (x86)"));
    roots.add(path.join(drive, "Adobe"));
  }
  return [...roots];
}

function addCandidate(found, exe) {
  if (!exe || !/AfterFX\.exe$/i.test(exe) || !fs.existsSync(exe)) return;
  const supportDir = path.dirname(exe);
  const installDir = path.dirname(supportDir);
  const name = path.basename(installDir) || "Adobe After Effects";
  const version = (name.match(/(\d{4})/) || (installDir.match(/(\d{4})/) || [, "0"]))[1];
  found.push({ name, exe, version });
}

/**
 * @param {{roots?: string[], registered?: string[]}} [options]
 * @returns {{name: string, exe: string, version: string}[]} 按版本升序
 */
function findAfterFX(options = {}) {
  const roots = Array.isArray(options.roots) ? options.roots : defaultRoots();
  const registered = Array.isArray(options.registered)
    ? options.registered
    : registeredAfterFXPaths();
  const found = [];

  for (const exe of registered) addCandidate(found, exe);

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
      addCandidate(found, exe);
    }
  }

  const unique = new Map();
  for (const item of found) unique.set(item.exe.toLowerCase(), item);
  return [...unique.values()].sort(
    (a, b) => Number(a.version) - Number(b.version) || a.name.localeCompare(b.name),
  );
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
