// Run ids and state locations. Pure apart from reading the environment.

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const pad = (n) => String(n).padStart(2, "0");

// YYYYMMDD-HHMMSS in local time, then six random hex characters. The id names
// the branch, the worktree, the run folder, the run's temp folder, and its
// process markers, so two runs started in the same second (on this machine or
// another one whose run folders are copied here) must never share it. Older
// runs used the bare timestamp; those folders are still read as they are.
export function runId(date = new Date()) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-` +
    crypto.randomBytes(3).toString("hex")
  );
}

// BUILD_LOOP_HOME overrides ~/.build-loop, which keeps tests out of the real one.
export function stateRoot(env = process.env) {
  return env.BUILD_LOOP_HOME || path.join(os.homedir(), ".build-loop");
}

export function runPaths(target, id, env = process.env) {
  const name = path.basename(target);
  const root = stateRoot(env);
  return {
    targetName: name,
    branch: `loop/${id}`,
    worktree: path.join(root, "worktrees", name, id),
    runDir: path.join(root, "runs", name, id),
    worktreesDir: path.join(root, "worktrees", name),
  };
}
