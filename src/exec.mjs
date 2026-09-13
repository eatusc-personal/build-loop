// Thin process helpers. Tested through the integration tests, not directly.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

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
export function runToFiles(cmd, args, { cwd, env, stdoutFile, stderrFile, timeoutMs, shell = false }) {
  return new Promise((resolve) => {
    const out = fs.openSync(stdoutFile, "w");
    const err = stderrFile && stderrFile !== stdoutFile ? fs.openSync(stderrFile, "w") : out;
    let timedOut = false;
    let timer = null;
    let killTimer = null;

    const child = spawn(cmd, args, {
      cwd,
      env,
      shell,
      detached: true,
      stdio: ["ignore", out, err],
    });

    const killGroup = (signal) => {
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

    const finish = (code, signal, error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (timedOut) killGroup("SIGKILL");
      fs.closeSync(out);
      if (err !== out) fs.closeSync(err);
      resolve({ code: error ? 127 : code, signal, timedOut, error: error ? error.message : null });
    };

    child.on("error", (e) => finish(null, null, e));
    child.on("close", (code, signal) => finish(code, signal, null));
  });
}
