// Git wrappers. parseStatusZ and parseWorktreeList are pure; the rest shell out.

import { run } from "./exec.mjs";

function git(cwd, args) {
  return run("git", ["-C", cwd, ...args]);
}

function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim().split("\n")[0]}`);
  return r.stdout;
}

// `git status --porcelain=v1 -z` output to a list of repo-relative paths.
// A rename or copy contributes both its new and its original path.
export function parseStatusZ(text) {
  const fields = text.split("\0");
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (xy.includes("R") || xy.includes("C")) paths.push(fields[++i]);
  }
  return [...new Set(paths)];
}

// `git worktree list --porcelain` output to [{ path, head, branch }].
export function parseWorktreeList(text) {
  return text
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => {
      const wt = { path: null, head: null, branch: null };
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) wt.path = line.slice(9);
        else if (line.startsWith("HEAD ")) wt.head = line.slice(5);
        else if (line.startsWith("branch ")) wt.branch = line.slice(7).replace(/^refs\/heads\//, "");
      }
      return wt;
    });
}

// `git diff --numstat` output to [{ path, added, removed }]. Binary files report null counts.
export function parseNumstat(text) {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...rest] = line.split("\t");
      return {
        path: rest.join("\t"),
        added: added === "-" ? null : Number(added),
        removed: removed === "-" ? null : Number(removed),
      };
    });
}

export const isRepo = (dir) => git(dir, ["rev-parse", "--git-dir"]).code === 0;
export const isDirty = (dir) => gitOk(dir, ["status", "--porcelain"]).trim() !== "";
export const currentBranch = (dir) => git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]).stdout.trim() || null;
export const branchExists = (dir, branch) => git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
export const revParse = (dir, ref) => gitOk(dir, ["rev-parse", ref]).trim();
export const showFile = (dir, ref, file) => {
  const r = git(dir, ["show", `${ref}:${file}`]);
  return r.code === 0 ? r.stdout : null;
};

export function worktreeAdd(target, branch, worktreePath, base) {
  gitOk(target, ["worktree", "add", "-b", branch, worktreePath, base]);
}

export function changedPaths(worktree) {
  return parseStatusZ(gitOk(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
}

export function commitAll(worktree, subject) {
  gitOk(worktree, ["add", "-A"]);
  gitOk(worktree, ["commit", "-q", "-m", subject]);
  return {
    hash: revParse(worktree, "HEAD"),
    files: parseNumstat(gitOk(worktree, ["diff", "--numstat", "HEAD~1", "HEAD"])),
  };
}

// Back to the last commit: tracked changes reverted, untracked files removed.
// Ignored files (node_modules, build output) are left alone.
export function discardChanges(worktree) {
  gitOk(worktree, ["checkout", "--", "."]);
  gitOk(worktree, ["clean", "-fd"]);
}

// Git's binary verdict on a file's current content, by diffing it against an
// empty file. `--numstat` prints "-\t-" for binary content.
export function isBinaryForGit(worktree, file) {
  const r = git(worktree, ["diff", "--no-index", "--numstat", "--", "/dev/null", file]);
  return /^-\t-\t/.test(r.stdout);
}

export const listWorktrees = (target) => parseWorktreeList(gitOk(target, ["worktree", "list", "--porcelain"]));
export const isAncestor = (dir, ref, base) => git(dir, ["merge-base", "--is-ancestor", ref, base]).code === 0;
export const worktreeRemove = (target, worktreePath) => gitOk(target, ["worktree", "remove", "--force", worktreePath]);
export const worktreePrune = (target) => gitOk(target, ["worktree", "prune"]);
