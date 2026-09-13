// Run ids and state locations. Pure apart from reading the environment.

import os from "node:os";
import path from "node:path";

const pad = (n) => String(n).padStart(2, "0");

// YYYYMMDD-HHMMSS in local time.
export function runId(date = new Date()) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
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
