// `build-loop clean`: remove loop worktrees whose branch is merged into base
// or no longer exists. Nothing else: branches, run logs, and reports stay.

import path from "node:path";
import * as git from "./git.mjs";
import { stateRoot } from "./paths.mjs";

export function clean({ target, base }, { out = (line) => process.stdout.write(`${line}\n`), env = process.env } = {}) {
  if (!git.isRepo(target)) throw new Error(`target is not a git repository: ${target}`);
  if (!git.branchExists(target, base)) throw new Error(`base branch does not exist: ${base}`);

  const prefix = path.join(stateRoot(env), "worktrees", path.basename(target)) + path.sep;
  const loopWorktrees = git.listWorktrees(target).filter((wt) => wt.path?.startsWith(prefix));
  const removed = [];

  for (const wt of loopWorktrees) {
    const gone = !wt.branch || !git.branchExists(target, wt.branch);
    const merged = !gone && git.isAncestor(target, wt.branch, base);
    if (!gone && !merged) {
      out(`kept     ${wt.path} (${wt.branch} is not merged into ${base})`);
      continue;
    }
    git.worktreeRemove(target, wt.path);
    removed.push(wt);
    out(`removed  ${wt.path} (${gone ? "branch deleted" : `${wt.branch} merged into ${base}`})`);
    if (!gone) out(`         branch kept; delete it with: git -C ${target} branch -d ${wt.branch}`);
  }

  if (loopWorktrees.length === 0) out("no build-loop worktrees for this target");
  return removed;
}
