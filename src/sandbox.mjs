// macOS Seatbelt sandbox for everything that runs code the agent may have
// written: the Claude session (its Bash commands run tests) and the gate.
// buildProfile is pure. In Seatbelt profiles the last matching rule wins, so
// broad denies come first and narrow allows after them.

import fs from "node:fs";
import path from "node:path";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export const sandboxAvailable = () => process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);

// Seatbelt string literal.
const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
// Seatbelt regex literal for an exact path prefix.
const rx = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// Secrets under the home folder that nothing in a run needs to read.
export const SECRET_PATHS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gh",
  ".docker",
  ".kube",
  ".netrc",
  ".npmrc",
  ".git-credentials",
  // Not Library/Keychains: the Claude CLI reads its login from the Keychain.
];

// Claude Code configuration an agent could use to change future sessions.
export const CLAUDE_CONFIG_PATHS = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/CLAUDE.md",
  ".claude/agents",
  ".claude/commands",
  ".claude/skills",
  ".claude/hooks",
  ".claude/plugins",
  ".claude/keybindings.json",
];

// kind: "claude" (the agent session) or "gate" (npm run check).
export function buildProfile({ kind, home, worktree, target, tmpDirs = [] }) {
  const lines = [
    "(version 1)",
    "(allow default)",
    "",
    ";; Writes: nothing under the home folder,",
    `(deny file-write* (subpath ${q(home)}))`,
    ";; temp folders are fine,",
    ...tmpDirs.map((dir) => `(allow file-write* (subpath ${q(dir)}))`),
    ";; npm writes debug logs here,",
    `(allow file-write* (subpath ${q(path.join(home, ".npm", "_logs"))}))`,
    ";; never the target checkout (denied after the temp allows, in case it lives under one),",
    `(deny file-write* (subpath ${q(target)}))`,
    ";; and the worktree is the workspace,",
    `(allow file-write* (subpath ${q(worktree)}))`,
    ";; except installed dependencies (the gate's own tools live there) and the",
    ";; .git pointer file that ties the worktree to its repository. These come",
    ";; after the temp allows so a worktree under a temp folder is still covered.",
    `(deny file-write* (subpath ${q(path.join(worktree, "node_modules"))}))`,
    `(allow file-write* (subpath ${q(path.join(worktree, "node_modules", ".vite"))}) (subpath ${q(path.join(worktree, "node_modules", ".cache"))}) (subpath ${q(path.join(worktree, "node_modules", ".vite-temp"))}))`,
    `(deny file-write* (literal ${q(path.join(worktree, ".git"))}))`,
  ];

  if (kind === "claude") {
    lines.push(
      "",
      ";; The Claude CLI keeps sessions and state here.",
      `(allow file-write* (subpath ${q(path.join(home, ".claude"))}))`,
      `(allow file-write* (regex #"^${rx(path.join(home, ".claude.json"))}"))`,
      ";; but not the configuration that would change later sessions.",
      ...CLAUDE_CONFIG_PATHS.map((p) => `(deny file-write* (subpath ${q(path.join(home, p))}))`),
      `(deny file-write* (regex #"^${rx(path.join(home, ".claude", "projects"))}/[^/]+/memory(/|$)"))`
    );
  }

  lines.push(
    "",
    ";; Reads: no secrets, no .env files outside the worktree, and none of the",
    ";; target checkout except its git directory, which the worktree needs.",
    ...SECRET_PATHS.map((p) => `(deny file-read* (subpath ${q(path.join(home, p))}))`),
    `(deny file-read* (regex #"/\\.env[^/]*$"))`,
    `(allow file-read* file-read-data (regex #"^${rx(worktree)}/"))`,
    ";; Path lookups in the target stay allowed (git resolves the worktree through it).",
    `(deny file-read-data (subpath ${q(target)}))`,
    ";; Named operations outrank file-read* in Seatbelt, so the git allow names file-read-data too.",
    `(allow file-read* file-read-data (subpath ${q(path.join(target, ".git"))}))`,
    ""
  );
  return lines.join("\n");
}

// The command and arguments to run `cmd args` inside a profile file.
export function wrap(profileFile, cmd, args) {
  return { cmd: SANDBOX_EXEC, args: ["-f", profileFile, cmd, ...args] };
}
