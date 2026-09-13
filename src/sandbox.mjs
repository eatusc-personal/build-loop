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
// Regex metacharacters in a path, escaped for an exact match.
const rx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A (regex ...) filter. The pattern goes in an ordinary string literal, not the
// #"..." raw form, because a raw literal cannot contain a double quote.
const re = (pattern) => `(regex ${q(pattern)})`;

// macOS per-user temp and cache folders, which system tools use no matter
// what TMPDIR says. Accepted only in their standard /private/var/folders shape,
// so an unusual environment can never widen the sandbox to something like $HOME.
const DARWIN_USER_DIR = /^\/private\/var\/folders\/[A-Za-z0-9_+-]{2}\/[A-Za-z0-9_+-]+\/[TC]$/;

export function darwinUserDirs({ getconf, realpath }) {
  const dirs = [];
  for (const name of ["DARWIN_USER_TEMP_DIR", "DARWIN_USER_CACHE_DIR"]) {
    try {
      const real = realpath(String(getconf(name)).trim().replace(/\/$/, ""));
      if (DARWIN_USER_DIR.test(real)) dirs.push(real);
    } catch {
      // Not macOS, or getconf failed: nothing added.
    }
  }
  return dirs;
}

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

// kind: "claude" (the agent session), "gate" (npm run check), or "install"
// (the install command, which can run lifecycle scripts from an unreviewed
// base branch when runs are stacked).
//
// Writes are denied everywhere by default and allowed only where a run needs
// them. npmCache is a cache owned by build-loop, so install scripts cannot
// touch the user's own ~/.npm.
export function buildProfile({ kind, home, worktree, target, tmpDirs = [], npmCache }) {
  const nodeModules = path.join(worktree, "node_modules");
  const lines = [
    "(version 1)",
    "(allow default)",
    "",
    ";; Writes: denied everywhere, then allowed only where a run needs them.",
    "(deny file-write*)",
    ";; Devices such as /dev/null and the terminal.",
    '(allow file-write* (subpath "/dev"))',
    ";; Temp folders.",
    ...tmpDirs.map((dir) => `(allow file-write* (subpath ${q(dir)}))`),
  ];

  if (npmCache) {
    lines.push(
      kind === "install"
        ? `(allow file-write* (subpath ${q(npmCache)}))`
        : `(allow file-write* (subpath ${q(path.join(npmCache, "_logs"))}))`
    );
  }

  lines.push(
    ";; Never the target checkout (denied after the temp allows, in case it lives under one).",
    `(deny file-write* (subpath ${q(target)}))`,
    ";; The worktree is the workspace.",
    `(allow file-write* (subpath ${q(worktree)}))`
  );

  if (kind !== "install") {
    lines.push(
      ";; Not installed dependencies (the gate's own tools live there), except caches test tools write.",
      `(deny file-write* (subpath ${q(nodeModules)}))`,
      `(allow file-write* (subpath ${q(path.join(nodeModules, ".vite"))}) (subpath ${q(path.join(nodeModules, ".vite-temp"))}) (subpath ${q(path.join(nodeModules, ".cache"))}))`
    );
  }

  lines.push(
    ";; Not the .git pointer file that ties the worktree to its repository.",
    `(deny file-write* (literal ${q(path.join(worktree, ".git"))}))`
  );

  if (kind === "claude") {
    lines.push(
      "",
      ";; The Claude CLI keeps sessions and logs here.",
      `(allow file-write* (subpath ${q(path.join(home, ".claude"))}))`,
      `(allow file-write* (subpath ${q(path.join(home, "Library", "Caches", "claude-cli-nodejs"))}))`,
      ";; Not the configuration that would change later sessions, including",
      ";; ~/.claude.json, which holds per-project permissions and MCP servers.",
      ...CLAUDE_CONFIG_PATHS.map((p) => `(deny file-write* (subpath ${q(path.join(home, p))}))`),
      `(deny file-write* ${re(`^${rx(path.join(home, ".claude.json"))}`)})`,
      `(deny file-write* ${re(`^${rx(path.join(home, ".claude", "projects"))}/[^/]+/memory(/|$)`)})`
    );
  }

  lines.push(
    "",
    ";; Reads: no secrets, no .env files outside the worktree, and none of the",
    ";; target checkout except its git directory, which the worktree needs.",
    ...SECRET_PATHS.map((p) => `(deny file-read* (subpath ${q(path.join(home, p))}))`),
    `(deny file-read* ${re("/\\.env[^/]*$")})`,
    `(allow file-read* file-read-data ${re(`^${rx(worktree)}/`)})`,
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
