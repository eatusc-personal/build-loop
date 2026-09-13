// Thin process helpers. Tested through the integration tests, not directly.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { PROC_MARKER, pidsWithMarker } from "./env.mjs";

// Kill every process whose environment still carries this run's marker. This
// reaches children that moved to a new process group or session. A process
// that rewrites its own environment can still escape; that limit is documented.
export function sweepMarked(marker) {
  if (!marker || process.platform !== "darwin") return [];
  const ps = spawnSync("ps", ["-axE", "-ww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const pids = pidsWithMarker(ps.stdout ?? "", marker, process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  return pids;
}

// Children started by runToFiles that have not exited yet. They run in their
// own process groups, so a Ctrl-C on the runner does not reach them; the
// runner's signal handler calls killActive() instead.
const active = new Set();

export function killActive(signal = "SIGKILL") {
  for (const pid of active) {
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  }
}

// Synchronous, captured. For short git commands.
export function run(cmd, args, { cwd, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    code: r.error ? 127 : r.status,
    stdout: r.stdout ?? "",
    stderr: r.error ? String(r.error.message) : (r.stderr ?? ""),
  };
}

// Asynchronous, output streamed to files. The child leads its own process
// group so a timeout can kill everything it started, not just the top process.
export function runToFiles(cmd, args, { cwd, env, stdoutFile, stderrFile, timeoutMs, shell = false, marker = null }) {
  return new Promise((resolve) => {
    const out = fs.openSync(stdoutFile, "w");
    const err = stderrFile && stderrFile !== stdoutFile ? fs.openSync(stderrFile, "w") : out;
    let timedOut = false;
    let timer = null;
    let killTimer = null;

    const child = spawn(cmd, args, {
      cwd,
      env: marker ? { ...env, [PROC_MARKER]: marker } : env,
      shell,
      detached: true,
      stdio: ["ignore", out, err],
    });
    if (child.pid) active.add(child.pid);

    const killGroup = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
    };

    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), 5000);
      }, timeoutMs);
    }

    // Runs once: Node can emit both "error" and "close" for a failed spawn.
    let finished = false;
    const finish = (code, signal, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      // The top process is gone, but anything it started in the background is
      // still in its process group. Kill the group every time, not only on timeout.
      killGroup("SIGKILL");
      sweepMarked(marker);
      active.delete(child.pid);
      fs.closeSync(out);
      if (err !== out) fs.closeSync(err);
      resolve({ code: error ? 127 : code, signal, timedOut, error: error ? error.message : null });
    };

    child.on("error", (e) => finish(null, null, e));
    child.on("close", (code, signal) => finish(code, signal, null));
  });
}
