import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { childEnv, pidsWithMarker } from "../../src/env.mjs";
import { buildProfile, darwinUserDirs, SANDBOX_EXEC, sandboxAvailable, wrap } from "../../src/sandbox.mjs";

const args = {
  home: "/Users/me",
  worktree: "/Users/me/.build-loop/worktrees/app/1",
  target: "/Users/me/code/app",
  tmpDirs: ["/private/tmp"],
  npmCache: "/Users/me/.build-loop/npm-cache",
};
const order = (profile, ...needles) =>
  needles.map((n) => {
    const i = profile.indexOf(n);
    expect(i, `missing: ${n}`).toBeGreaterThanOrEqual(0);
    return i;
  });
const ascending = (idx) => expect([...idx].sort((a, b) => a - b)).toEqual(idx);

describe("buildProfile", () => {
  const gate = buildProfile({ kind: "gate", ...args });
  const claude = buildProfile({ kind: "claude", ...args });
  const install = buildProfile({ kind: "install", ...args });

  it("denies all writes first, then allows devices, temp, the worktree, and denies node_modules and .git last", () => {
    ascending(
      order(
        gate,
        "(deny file-write*)",
        '(allow file-write* (subpath "/dev"))',
        '(allow file-write* (subpath "/private/tmp"))',
        '(deny file-write* (subpath "/Users/me/code/app"))',
        '(allow file-write* (subpath "/Users/me/.build-loop/worktrees/app/1"))',
        '(deny file-write* (subpath "/Users/me/.build-loop/worktrees/app/1/node_modules"))',
        '(deny file-write* (literal "/Users/me/.build-loop/worktrees/app/1/.git"))'
      )
    );
    expect(gate).not.toContain('(deny file-write* (subpath "/Users/me"))');
  });

  it("gives install node_modules and the build-loop npm cache, and the others only its logs", () => {
    expect(install).toContain('(allow file-write* (subpath "/Users/me/.build-loop/npm-cache"))');
    expect(install).not.toContain("worktrees/app/1/node_modules\"))");
    expect(gate).toContain('(allow file-write* (subpath "/Users/me/.build-loop/npm-cache/_logs"))');
    expect(gate).not.toContain('(allow file-write* (subpath "/Users/me/.build-loop/npm-cache"))');
    expect(install).not.toContain('(allow file-write* (subpath "/Users/me/.npm');
  });

  it("hides secrets and the target's files, but lets git read the target's .git", () => {
    expect(gate).toContain('(deny file-read* (subpath "/Users/me/.ssh"))');
    expect(gate).toContain('(deny file-read* (subpath "/Users/me/.config/gh"))');
    expect(gate).toContain('(deny file-read* (regex "/\\\\.env[^/]*$"))');
    ascending(order(gate, '(deny file-read-data (subpath "/Users/me/code/app"))', '(allow file-read* file-read-data (subpath "/Users/me/code/app/.git"))'));
  });

  it("lets only the Claude session write its own state, never its configuration or ~/.claude.json", () => {
    expect(gate).not.toContain("/Users/me/.claude");
    ascending(
      order(
        claude,
        '(allow file-write* (subpath "/Users/me/.claude"))',
        '(deny file-write* (subpath "/Users/me/.claude/settings.json"))',
        '(deny file-write* (subpath "/Users/me/.claude/hooks"))',
        '(deny file-write* (regex "^/Users/me/\\\\.claude\\\\.json"))',
        '(deny file-write* (regex "^/Users/me/\\\\.claude/projects/[^/]+/memory(/|$)"))'
      )
    );
  });

  it("escapes quotes in paths", () => {
    expect(buildProfile({ kind: "gate", ...args, worktree: '/tmp/a"b' })).toContain('(allow file-write* (subpath "/tmp/a\\"b"))');
  });
});

describe("darwinUserDirs", () => {
  const values = (map) => ({ getconf: (name) => map[name], realpath: (p) => p });

  it("accepts the standard per-user temp and cache folders", () => {
    expect(
      darwinUserDirs(values({ DARWIN_USER_TEMP_DIR: "/private/var/folders/7j/9wch7jwd6l38r9_dn7mw_b1c0000gn/T/", DARWIN_USER_CACHE_DIR: "/private/var/folders/7j/9wch7jwd6l38r9_dn7mw_b1c0000gn/C/" }))
    ).toEqual(["/private/var/folders/7j/9wch7jwd6l38r9_dn7mw_b1c0000gn/T", "/private/var/folders/7j/9wch7jwd6l38r9_dn7mw_b1c0000gn/C"]);
  });

  it("rejects anything that would widen the sandbox", () => {
    for (const bad of ["/Users/me", "/private/tmp", "/", "/private/var/folders", "/private/var/folders/7j/x/T/../../..", "/private/var/folders/7j/x/Documents"]) {
      expect(darwinUserDirs(values({ DARWIN_USER_TEMP_DIR: bad, DARWIN_USER_CACHE_DIR: bad })), bad).toEqual([]);
    }
    expect(darwinUserDirs({ getconf: () => { throw new Error("no getconf"); }, realpath: (p) => p })).toEqual([]);
  });
});

describe("profiles load in the real sandbox-exec", () => {
  it.skipIf(!sandboxAvailable())("with quotes, spaces, and parentheses in every path", () => {
    // Seatbelt matches real paths, so the fixture uses one (/var is /private/var).
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl "odd" (paths) ')));
    try {
      const odd = { home: os.homedir(), worktree: path.join(dir, 'work "tree"'), target: path.join(dir, "target (app)"), tmpDirs: [dir], npmCache: path.join(dir, "npm cache") };
      fs.mkdirSync(odd.worktree);
      for (const kind of ["install", "claude", "gate"]) {
        const file = path.join(dir, `${kind}.sb`);
        fs.writeFileSync(file, buildProfile({ kind, ...odd }));
        const out = path.join(odd.worktree, `${kind}.txt`);
        const r = spawnSync(SANDBOX_EXEC, ["-f", file, "/bin/sh", "-c", 'echo ok > "$1"', "sh", out], { encoding: "utf8" });
        expect(r.stderr, kind).toBe("");
        expect(r.status, kind).toBe(0);
        expect(fs.readFileSync(path.join(odd.worktree, `${kind}.txt`), "utf8")).toBe("ok\n");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("wrap", () => {
  it("runs the command under sandbox-exec with the profile", () => {
    expect(wrap("/runs/1/sandbox-gate.sb", "npm", ["run", "check"])).toEqual({ cmd: SANDBOX_EXEC, args: ["-f", "/runs/1/sandbox-gate.sb", "npm", "run", "check"] });
  });
});

describe("childEnv", () => {
  const parent = {
    HOME: "/Users/me",
    PATH: "/usr/bin",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "sk-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    GITHUB_TOKEN: "ghp-secret",
    SSH_AUTH_SOCK: "/tmp/agent",
    NPM_TOKEN: "npm-secret",
  };

  it("keeps the allowlist and drops everything else", () => {
    expect(childEnv(parent, { npm_config_cache: "/c" })).toEqual({
      HOME: "/Users/me",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      npm_config_cache: "/c",
    });
  });

  it("passes names listed in BUILD_LOOP_PASS_ENV, and only those", () => {
    const env = childEnv({ ...parent, BUILD_LOOP_PASS_ENV: "ANTHROPIC_API_KEY, MISSING" });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-secret");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("MISSING");
  });
});

describe("pidsWithMarker", () => {
  it("finds processes by an exact environment entry and never returns itself", () => {
    const ps = [
      "  101 node -e x BUILD_LOOP_PROC=run1-claude HOME=/Users/me",
      "  102 node other.js BUILD_LOOP_PROC=run1-claude-extra",
      "  103 sh -c y PATH=/bin BUILD_LOOP_PROC=run1-claude",
      "  104 grep BUILD_LOOP_PROC=run1-claude",
      "  bad line",
    ].join("\n");
    expect(pidsWithMarker(ps, "run1-claude", 104)).toEqual([101, 103]);
    expect(pidsWithMarker("", "x", 1)).toEqual([]);
  });
});
