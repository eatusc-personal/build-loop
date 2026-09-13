// The gate and the install command. The runner only reads exit codes; what
// `npm run check` does is the target's business.

import fs from "node:fs";
import path from "node:path";
import { runToFiles } from "./exec.mjs";
import { wrap } from "./sandbox.mjs";

export function defaultInstall(worktree) {
  return fs.existsSync(path.join(worktree, "package-lock.json")) ? "npm ci" : "npm install";
}

// The install runs sandboxed too when a profile is given: with --base on an
// unreviewed loop branch, its package.json lifecycle scripts are agent-written.
export async function runInstall(worktree, command, logFile, { profileFile = null, env, timeoutMs, marker } = {}) {
  const { cmd, args } = profileFile ? wrap(profileFile, "/bin/sh", ["-c", command]) : { cmd: "/bin/sh", args: ["-c", command] };
  const r = await runToFiles(cmd, args, { cwd: worktree, env, stdoutFile: logFile, timeoutMs, marker });
  return { ok: r.code === 0 && !r.timedOut, code: r.code, timedOut: r.timedOut };
}

// With a profile, the gate runs inside the sandbox: it executes tests the agent
// wrote, so it gets the same limits as the agent.
export async function runGate(worktree, logFile, { profileFile = null, env, timeoutMs, marker } = {}) {
  const { cmd, args } = profileFile ? wrap(profileFile, "npm", ["run", "check"]) : { cmd: "npm", args: ["run", "check"] };
  const r = await runToFiles(cmd, args, { cwd: worktree, env, stdoutFile: logFile, timeoutMs, marker });
  return { ok: r.code === 0 && !r.timedOut, code: r.code, timedOut: r.timedOut };
}

export function hasCheckScript(packageJsonText) {
  try {
    const scripts = JSON.parse(packageJsonText)?.scripts;
    return typeof scripts?.check === "string" && scripts.check.trim() !== "";
  } catch {
    return false;
  }
}
