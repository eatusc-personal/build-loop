// `build-loop clean`: remove loop worktrees whose branch is merged into base
// or no longer exists. Nothing else: branches, run logs, and reports stay.

import fs from "node:fs";
import path from "node:path";
import * as git from "./git.mjs";
import { stateRoot } from "./paths.mjs";
import { currentMachine } from "./provenance.mjs";
import { shq } from "./report.mjs";

// A run is live when its state says running, it was started on this machine,
// and its process still exists. A run that crashed mid-way reads as running
// forever, so the process check is what lets its worktree be cleaned.
export function isLiveRun(state, { thisMachine, pidAlive }) {
  if (!state || state.outcome !== "running") return false;
  if (state.machine?.name && state.machine.name !== thisMachine) return true; // cannot check; assume live
  return typeof state.pid === "number" ? pidAlive(state.pid) : true;
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

const readState = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

export function clean({ target, base }, { out = (line) => process.stdout.write(`${line}\n`), env = process.env } = {}) {
  if (!git.isRepo(target)) throw new Error(`target is not a git repository: ${target}`);
  if (!git.branchExists(target, base)) throw new Error(`base branch does not exist: ${base}`);

  const root = stateRoot(env);
  const prefix = path.join(root, "worktrees", path.basename(target)) + path.sep;
  const thisMachine = currentMachine(env).name;
  const loopWorktrees = git.listWorktrees(target).filter((wt) => wt.path?.startsWith(prefix));
  const removed = [];

  for (const wt of loopWorktrees) {
    const gone = !wt.branch || !git.branchExists(target, wt.branch);
    const merged = !gone && git.isAncestor(target, wt.branch, base);
    if (!gone && !merged) {
      out(`kept     ${wt.path} (${wt.branch} is not merged into ${base})`);
      continue;
    }
    // A branch still at the base commit also counts as merged, which is true of a
    // run that has not landed anything yet. Never remove a live run or local work.
    const state = readState(path.join(root, "runs", path.basename(target), path.basename(wt.path), "state.json"));
    if (isLiveRun(state, { thisMachine, pidAlive })) {
      out(`kept     ${wt.path} (run in progress, pid ${state.pid ?? "unknown"})`);
      continue;
    }
    if (fs.existsSync(wt.path) && git.isDirty(wt.path)) {
      out(`kept     ${wt.path} (uncommitted changes in the worktree)`);
      continue;
    }
    git.worktreeRemove(target, wt.path);
    removed.push(wt);
    out(`removed  ${wt.path} (${gone ? "branch deleted" : `${wt.branch} merged into ${base}`})`);
    if (!gone) out(`         branch kept; delete it with: git -C ${shq(target)} branch -d ${shq(wt.branch)}`);
  }

  if (loopWorktrees.length === 0) out("no build-loop worktrees for this target");
  return removed;
}
