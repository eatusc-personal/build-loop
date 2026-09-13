// The gate and the install command. The runner only reads exit codes; what
// `npm run check` does is the target's business.

import fs from "node:fs";
import path from "node:path";
import { runToFiles } from "./exec.mjs";
import { wrap } from "./sandbox.mjs";

export function defaultInstall(worktree) {
  return fs.existsSync(path.join(worktree, "package-lock.json")) ? "npm ci" : "npm install";
}

export async function runInstall(worktree, command, logFile) {
  const r = await runToFiles(command, [], { cwd: worktree, env: process.env, stdoutFile: logFile, shell: true });
  return { ok: r.code === 0, code: r.code };
}

// With a profile, the gate runs inside the sandbox: it executes tests the agent
// wrote, so it gets the same limits as the agent.
export async function runGate(worktree, logFile, profileFile = null) {
  const { cmd, args } = profileFile ? wrap(profileFile, "npm", ["run", "check"]) : { cmd: "npm", args: ["run", "check"] };
  const r = await runToFiles(cmd, args, { cwd: worktree, env: process.env, stdoutFile: logFile });
  return { ok: r.code === 0, code: r.code };
}

export function hasCheckScript(packageJsonText) {
  try {
    const scripts = JSON.parse(packageJsonText)?.scripts;
    return typeof scripts?.check === "string" && scripts.check.trim() !== "";
  } catch {
    return false;
  }
}
