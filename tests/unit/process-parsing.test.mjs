import { describe, expect, it } from "vitest";
import { ALLOWED_TOOLS, buildClaudeArgs, parseClaudeOutput } from "../../src/claude.mjs";
import { hasCheckScript } from "../../src/gate.mjs";
import { parseNumstat, parseStatusZ, parseWorktreeList } from "../../src/git.mjs";

describe("buildClaudeArgs", () => {
  it("builds a print-mode call with an allow list and no permission bypass", () => {
    const args = buildClaudeArgs({ prompt: "do it", model: "sonnet", maxTurns: 60 });
    expect(args).toEqual([
      "-p", "do it",
      "--output-format", "json",
      "--model", "sonnet",
      "--max-turns", "60",
      "--permission-mode", "dontAsk",
      "--allowedTools", ALLOWED_TOOLS,
    ]);
    expect(args.join(" ")).not.toContain("dangerously");
    expect(ALLOWED_TOOLS).toContain("Bash(npm run check)");
    expect(ALLOWED_TOOLS).not.toContain("git commit");
  });
});

describe("parseClaudeOutput", () => {
  it("reads the fields it knows and tolerates missing ones", () => {
    const out = parseClaudeOutput(
      JSON.stringify({ type: "result", result: "done", is_error: false, num_turns: 7, total_cost_usd: 0.42, permission_denials: [{}, {}] })
    );
    expect(out).toEqual({
      parsed: true,
      result: "done",
      is_error: false,
      num_turns: 7,
      total_cost_usd: 0.42,
      duration_ms: null,
      permission_denials: 2,
    });
  });

  it("takes the last JSON line after log noise, and reports unparseable output", () => {
    expect(parseClaudeOutput('warning: something\n{"result":"ok"}\n').result).toBe("ok");
    expect(parseClaudeOutput("not json").parsed).toBe(false);
    expect(parseClaudeOutput("").parsed).toBe(false);
  });
});

describe("git output parsing", () => {
  it("parses porcelain -z status, including renames and untracked files", () => {
    const text = [" M app/route.js", "?? tests/new.test.js", "R  lib/new.js", "lib/old.js", "D  gone.txt", ""].join("\0");
    expect(parseStatusZ(text)).toEqual(["app/route.js", "tests/new.test.js", "lib/new.js", "lib/old.js", "gone.txt"]);
    expect(parseStatusZ("")).toEqual([]);
  });

  it("parses worktree list porcelain output", () => {
    const text = `worktree /repo
HEAD abc
branch refs/heads/main

worktree /home/.build-loop/worktrees/repo/20260912-120000
HEAD def
branch refs/heads/loop/20260912-120000

worktree /tmp/detached
HEAD 123
detached
`;
    expect(parseWorktreeList(text)).toEqual([
      { path: "/repo", head: "abc", branch: "main" },
      { path: "/home/.build-loop/worktrees/repo/20260912-120000", head: "def", branch: "loop/20260912-120000" },
      { path: "/tmp/detached", head: "123", branch: null },
    ]);
  });

  it("parses numstat, including binary files", () => {
    expect(parseNumstat("12\t3\tapp/route.js\n-\t-\tlogo.png\n")).toEqual([
      { path: "app/route.js", added: 12, removed: 3 },
      { path: "logo.png", added: null, removed: null },
    ]);
  });
});

describe("hasCheckScript", () => {
  it("requires a non-empty check script", () => {
    expect(hasCheckScript('{"scripts":{"check":"npm test"}}')).toBe(true);
    expect(hasCheckScript('{"scripts":{"test":"vitest"}}')).toBe(false);
    expect(hasCheckScript('{"scripts":{"check":"  "}}')).toBe(false);
    expect(hasCheckScript("not json")).toBe(false);
  });
});
