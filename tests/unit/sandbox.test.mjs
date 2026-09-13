import { describe, expect, it } from "vitest";
import { buildProfile, SANDBOX_EXEC, wrap } from "../../src/sandbox.mjs";

const args = { home: "/Users/me", worktree: "/Users/me/.build-loop/worktrees/app/1", target: "/Users/me/code/app", tmpDirs: ["/private/tmp"] };
const order = (profile, ...needles) => needles.map((n) => {
  const i = profile.indexOf(n);
  expect(i, `missing: ${n}`).toBeGreaterThanOrEqual(0);
  return i;
});

describe("buildProfile", () => {
  const gate = buildProfile({ kind: "gate", ...args });
  const claude = buildProfile({ kind: "claude", ...args });

  it("denies writes under home, then allows temp, then denies the target, then allows the worktree, then denies node_modules", () => {
    const idx = order(
      gate,
      '(deny file-write* (subpath "/Users/me"))',
      '(allow file-write* (subpath "/private/tmp"))',
      '(deny file-write* (subpath "/Users/me/code/app"))',
      '(allow file-write* (subpath "/Users/me/.build-loop/worktrees/app/1"))',
      '(deny file-write* (subpath "/Users/me/.build-loop/worktrees/app/1/node_modules"))',
      '(deny file-write* (literal "/Users/me/.build-loop/worktrees/app/1/.git"))'
    );
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it("hides secrets and the target's files, but lets git read the target's .git", () => {
    expect(gate).toContain('(deny file-read* (subpath "/Users/me/.ssh"))');
    expect(gate).toContain('(deny file-read* (subpath "/Users/me/.config/gh"))');
    expect(gate).toContain('(deny file-read* (regex #"/\\.env[^/]*$"))');
    const idx = order(gate, '(deny file-read-data (subpath "/Users/me/code/app"))', '(allow file-read* file-read-data (subpath "/Users/me/code/app/.git"))');
    expect(idx[0]).toBeLessThan(idx[1]);
  });

  it("lets only the Claude session write its own state, never its configuration", () => {
    expect(gate).not.toContain("/Users/me/.claude");
    const idx = order(claude, '(allow file-write* (subpath "/Users/me/.claude"))', '(deny file-write* (subpath "/Users/me/.claude/settings.json"))', '(deny file-write* (subpath "/Users/me/.claude/hooks"))');
    expect(idx[0]).toBeLessThan(idx[1]);
    expect(claude).toContain('(deny file-write* (regex #"^\\/Users\\/me\\/\\.claude\\/projects/[^/]+/memory(/|$)"))');
  });

  it("escapes quotes in paths", () => {
    expect(buildProfile({ kind: "gate", ...args, worktree: '/tmp/a"b' })).toContain('(allow file-write* (subpath "/tmp/a\\"b"))');
  });
});

describe("wrap", () => {
  it("runs the command under sandbox-exec with the profile", () => {
    expect(wrap("/runs/1/sandbox-gate.sb", "npm", ["run", "check"])).toEqual({ cmd: SANDBOX_EXEC, args: ["-f", "/runs/1/sandbox-gate.sb", "npm", "run", "check"] });
  });
});
