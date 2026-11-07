/* Plugin effect preview scheduler.
 *
 * The actual rendering/crash-blacklist/index logic lives in the installed
 * extension. Hub only launches generate_plugin_effects.ps1 and mirrors its
 * state file into the UI.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

function readStateFile(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

class PluginEffectJob {
  constructor(opts) {
    this.paths = opts.paths;
    this.script = opts.script;
    this.powershell = opts.powershell || "powershell.exe";
    this.onState = opts.onState || (() => {});
    this.onExit = opts.onExit || (() => {});
    this.proc = null;
    this.timer = null;
    this.running = false;
    this.lastState = null;
  }

  isRunning() {
    return this.running;
  }

  start(options = {}) {
    if (this.running) return { ok: false, reason: "already_running" };
    if (!this.script || !fs.existsSync(this.script)) {
      return { ok: false, reason: "no_script", detail: this.script };
    }

    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.script,
      "-Ae",
      String(options.ae || ""),
      "-Probe",
      this.paths.probe,
      "-Extension",
      this.paths.extDir,
      "-Limit",
      String(Number(options.limit) || 8),
      "-Rounds",
      String(Number(options.rounds) || 200),
      "-Background",
      String(options.background || ""),
    ];

    try {
      fs.rmSync(this.paths.pluginEffectState, { force: true });
    } catch {
      /* stale state is harmless */
    }
    try {
      this.proc = spawn(this.powershell, args, {
        cwd: path.dirname(this.script),
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch (error) {
      return { ok: false, reason: "spawn_failed", detail: String(error.message || error) };
    }
    this.running = true;
    this.lastState = null;
    this.proc.on("exit", (code, signal) => {
      this.running = false;
      this.stopPolling();
      const finalState = readStateFile(this.paths.pluginEffectState) || this.lastState;
      this.lastState = finalState;
      if (finalState) this.onState(finalState);
      this.onExit({ code, signal, state: finalState });
    });
    this.startPolling();
    return { ok: true, pid: this.proc.pid };
  }

  startPolling() {
    this.stopPolling();
    this.timer = setInterval(() => {
      const state = readStateFile(this.paths.pluginEffectState);
      if (!state) return;
      this.lastState = state;
      this.onState(state);
    }, 500);
  }

  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop() {
    if (!this.proc || !this.running) return { ok: false, reason: "not_running" };
    const pid = this.proc.pid;
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        windowsHide: true,
        timeout: 8000,
      });
    } catch {
      try {
        this.proc.kill();
      } catch {
        /* already exited */
      }
    }
    try {
      const state = {
        ...(this.lastState || {}),
        phase: "cancelled",
        message: "已手动停止，下次开始会从断点继续",
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.paths.pluginEffectState, JSON.stringify(state), "utf8");
      this.lastState = state;
    } catch {
      /* state write is best effort */
    }
    return { ok: true, pid };
  }

  snapshot() {
    return readStateFile(this.paths.pluginEffectState);
  }
}

module.exports = { PluginEffectJob, readStateFile };
