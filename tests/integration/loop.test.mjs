// End-to-end runs of bin/loop.mjs against throwaway git repos, with
// tests/fake-claude.mjs standing in for the Claude CLI. The real `claude`
// is never run here.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = path.join(ROOT, "bin/loop.mjs");
const FAKE = path.join(ROOT, "tests/fake-claude.mjs");

const tmpRoots = [];
let tmp;

afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "build-loop-it-")));
  tmpRoots.push(tmp);
});

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// A repo whose gate fails while status.txt contains "red".
function makeTarget({ status = "green" } = {}) {
  const repo = path.join(tmp, "target-app");
  fs.mkdirSync(repo);
  sh(repo, "git", ["init", "-q", "-b", "main"]);
  sh(repo, "git", ["config", "user.email", "test@example.com"]);
  sh(repo, "git", ["config", "user.name", "Test"]);
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "target-app", private: true, scripts: { check: "node check.mjs" } }, null, 2)
  );
  fs.writeFileSync(
    path.join(repo, "check.mjs"),
    `import fs from "node:fs";
if (fs.readFileSync("status.txt", "utf8").includes("red")) {
  console.log("CHECK SAYS RED MARKER");
  process.exit(1);
}
console.log("check passed");
`
  );
  fs.writeFileSync(path.join(repo, "status.txt"), `${status}\n`);
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", "init"]);
  return repo;
}

function writeSteps(content) {
  const file = path.join(tmp, "steps.md");
  fs.writeFileSync(file, content);
  return file;
}

function runLoop(target, steps, { plan, extra = [], stateEnv = {} } = {}) {
  const fakeState = path.join(tmp, "fake-state");
  fs.mkdirSync(fakeState, { recursive: true });
  const started = Date.now();
  const r = spawnSync(
    "node",
    [BIN, "--target", target, "--steps", steps, "--install", "true", "--claude-cmd", FAKE, ...extra],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        BUILD_LOOP_HOME: path.join(tmp, "state"),
        FAKE_CLAUDE_STATE: fakeState,
        FAKE_CLAUDE_PLAN: JSON.stringify(plan ?? [{ do: "nothing" }]),
        ...stateEnv,
      },
    }
  );
  const lines = r.stdout.trim().split("\n");
  const reportPath = lines.at(-2);
  const branch = lines.at(-1);
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    elapsedMs: Date.now() - started,
    reportPath,
    branch,
    report: reportPath && fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : null,
    runDir: reportPath ? path.dirname(reportPath) : null,
    fakeState,
    calls: fs.existsSync(path.join(fakeState, "calls")) ? Number(fs.readFileSync(path.join(fakeState, "calls"), "utf8")) : 0,
  };
}

const stepsGreen = `# Test run

## Step 1: Make it green

Write green into status.txt.

DONE WHEN: the gate passes.

ALLOWED: status.txt, notes/**
`;

describe("build-loop against a throwaway repo", () => {
  it("commits a green step on its own branch and leaves the target checkout alone", () => {
    const target = makeTarget();
    const mainBefore = sh(target, "git", ["rev-parse", "main"]);
    const r = runLoop(target, writeSteps(stepsGreen), { plan: [{ do: "write", path: "notes/a.md", content: "hello\n" }] });

    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.branch).toMatch(/^loop\/\d{8}-\d{6}$/);
    expect(sh(target, "git", ["log", "-1", "--format=%s", r.branch])).toBe("loop: Step 1: Make it green");
    expect(sh(target, "git", ["diff", "--name-only", `main..${r.branch}`])).toBe("notes/a.md");
    expect(r.report).toMatch(/\| 1 \| Step 1: Make it green \| landed \| 1 \|/);
    expect(r.report).toContain("Outcome: **all steps landed**");
    expect(r.stdout).toMatch(/\[\d\d:\d\d:\d\d\] landed [0-9a-f]{7}/);

    // Target untouched: same branch, same commit, clean tree.
    expect(sh(target, "git", ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(sh(target, "git", ["rev-parse", "main"])).toBe(mainBefore);
    expect(sh(target, "git", ["status", "--porcelain"])).toBe("");

    // The prompt carried the step, its finish line, and its allowed paths; the target Stop hook is switched off.
    const prompt = fs.readFileSync(path.join(r.fakeState, "prompt-1.txt"), "utf8");
    expect(prompt).toContain("unattended build loop");
    expect(prompt).toContain("## Step 1: Make it green");
    expect(prompt).toContain("DONE WHEN: the gate passes.");
    expect(prompt).toContain("You may only change these paths:\n\n- status.txt\n- notes/**");
    expect(JSON.parse(fs.readFileSync(path.join(r.fakeState, "env-1.json"), "utf8")).LEARNING_LOOP).toBe("0");
    expect(JSON.parse(fs.readFileSync(path.join(r.fakeState, "args-1.json"), "utf8"))).toContain("dontAsk");
  });

  it("retries a red step and feeds the gate log back into the next prompt", () => {
    const target = makeTarget();
    const r = runLoop(target, writeSteps(stepsGreen), {
      plan: [
        { do: "write", path: "status.txt", content: "red\n" },
        { do: "write", path: "status.txt", content: "green again\n" },
      ],
    });

    expect(r.code).toBe(0);
    expect(r.calls).toBe(2);
    const second = fs.readFileSync(path.join(r.fakeState, "prompt-2.txt"), "utf8");
    expect(second).toContain("Attempt 2 of 3. Your previous attempt is still in the working tree. The gate failed.");
    expect(second).toContain("CHECK SAYS RED MARKER");
    expect(fs.readFileSync(path.join(r.fakeState, "prompt-1.txt"), "utf8")).not.toContain("Attempt");
    expect(r.report).toMatch(/\| 1 \| Step 1: Make it green \| landed \| 2 \|/);
    expect(fs.existsSync(path.join(r.runDir, "step-1-attempt-1.gate.log"))).toBe(true);
  });

  it("fails a scope violation before the gate runs and resets the tree", () => {
    const target = makeTarget();
    const r = runLoop(target, writeSteps(stepsGreen), {
      plan: [{ do: "write", path: "lib/outside.js", content: "export {};\n" }],
      extra: ["--attempts", "2"],
    });

    expect(r.code).toBe(1);
    expect(r.calls).toBe(2);
    expect(fs.existsSync(path.join(r.runDir, "step-1-attempt-1.gate.log"))).toBe(false);
    expect(fs.existsSync(path.join(r.runDir, "step-1-attempt-2.gate.log"))).toBe(false);
    expect(fs.readFileSync(path.join(r.fakeState, "prompt-2.txt"), "utf8")).toContain("outside the allowed paths");
    expect(fs.readFileSync(path.join(r.fakeState, "prompt-2.txt"), "utf8")).toContain("- lib/outside.js");
    expect(r.report).toMatch(/\| 1 \| Step 1: Make it green \| failed \| 2 \| 2 \| \$0\.02 \| scope: lib\/outside.js \|/);
    expect(r.report).toContain("Outcome: **stopped**");

    const worktree = r.report.match(/\| Worktree \| `([^`]+)` \|/)[1];
    expect(sh(worktree, "git", ["status", "--porcelain"])).toBe("");
    expect(sh(target, "git", ["rev-list", "--count", `main..${r.branch}`])).toBe("0");
  });

  it("fails an attempt that leaves a raw NUL byte in a .js file before the gate runs", () => {
    const target = makeTarget();
    const r = runLoop(target, writeSteps(stepsGreen), {
      plan: [
        { do: "write", path: "notes/key.js", content: "export const key = (a, b) => `${a}\u0000${b}`;\n" },
        { do: "write", path: "notes/key.js", content: "export const key = (a, b) => JSON.stringify([a, b]);\n" },
      ],
    });

    expect(r.code).toBe(0);
    expect(r.calls).toBe(2);
    expect(fs.existsSync(path.join(r.runDir, "step-1-attempt-1.gate.log"))).toBe(false);
    expect(r.stdout).toContain("step 1 attempt 1 unreviewable: notes/key.js line 1 (0x00)");
    const second = fs.readFileSync(path.join(r.fakeState, "prompt-2.txt"), "utf8");
    expect(second).toContain("cannot show as a text diff");
    expect(second).toContain("- notes/key.js line 1 (0x00)");
    expect(r.report).toMatch(/\| 1 \| Step 1: Make it green \| landed \| 2 \|/);
    const state = JSON.parse(fs.readFileSync(path.join(r.runDir, "state.json"), "utf8"));
    expect(state.steps[0].attempts[0].reason).toBe("unreviewable");
  });

  it("reports unreviewable as the failure reason when every attempt leaves a control character", () => {
    const target = makeTarget();
    const r = runLoop(target, writeSteps(stepsGreen), {
      plan: [{ do: "write", path: "notes/colors.md", content: "red is \u001b[31m\n" }],
      extra: ["--attempts", "1"],
    });

    expect(r.code).toBe(1);
    expect(r.report).toMatch(/\| failed \| 1 \|.*unreviewable: notes\/colors.md line 1 \(0x1b\) \|/);
  });

  it("lets an attempt land that removes a stray byte from an existing file", () => {
    const target = makeTarget();
    fs.mkdirSync(path.join(target, "notes"));
    fs.writeFileSync(path.join(target, "notes/old.js"), "export const k = `a\u0000b`;\n");
    sh(target, "git", ["add", "-A"]);
    sh(target, "git", ["commit", "-q", "-m", "a file git sees as binary"]);

    const r = runLoop(target, writeSteps(stepsGreen), {
      plan: [{ do: "write", path: "notes/old.js", content: "export const k = JSON.stringify([\"a\", \"b\"]);\n" }],
      extra: ["--attempts", "1"],
    });

    expect(r.code).toBe(0);
    expect(r.report).toMatch(/\| 1 \| Step 1: Make it green \| landed \| 1 \|/);
  });

  it("kills and reports a Claude call that runs past the timeout", () => {
    const target = makeTarget();
    const r = runLoop(target, writeSteps(stepsGreen), {
      plan: [{ do: "sleep", ms: 120000 }],
      extra: ["--attempts", "1", "--timeout", "0.03"],
    });

    expect(r.code).toBe(1);
    expect(r.elapsedMs).toBeLessThan(30000);
    expect(r.report).toMatch(/\| failed \| 1 \| - \| - \| timeout \|/);
    const pid = Number(fs.readFileSync(path.join(r.fakeState, "pid-1.txt"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("refuses to start from a red baseline without calling Claude", () => {
    const target = makeTarget({ status: "red" });
    const r = runLoop(target, writeSteps(stepsGreen), { plan: [{ do: "write", path: "status.txt", content: "green\n" }] });

    expect(r.code).toBe(1);
    expect(r.calls).toBe(0);
    expect(r.report).toContain("Outcome: **refused**. baseline red");
    expect(r.report).toContain("CHECK SAYS RED MARKER");
    expect(r.report).toMatch(/\| 1 \| Step 1: Make it green \| skipped \| 0 \|/);
  });

  it("refuses a dirty target before creating anything", () => {
    const target = makeTarget();
    fs.writeFileSync(path.join(target, "scratch.txt"), "uncommitted\n");
    const r = runLoop(target, writeSteps(stepsGreen));

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("refusing to start: target has uncommitted changes");
    expect(r.stdout).toBe("");
    expect(fs.existsSync(path.join(tmp, "state"))).toBe(false);
    expect(sh(target, "git", ["branch", "--list", "loop/*"])).toBe("");
  });

  it("refuses a steps file with no steps and a target with no check script", () => {
    const target = makeTarget();
    expect(runLoop(target, writeSteps("# Nothing here\n\njust prose\n")).stderr).toContain("steps file has no steps");

    fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "x", scripts: {} }));
    sh(target, "git", ["commit", "-qam", "drop check"]);
    expect(runLoop(target, writeSteps(stepsGreen)).stderr).toContain('has no "check" script');
    expect(runLoop(target, writeSteps(stepsGreen), { extra: ["--base", "nope"] }).stderr).toContain("base branch does not exist: nope");
  });

  const threeSteps = `## Step 1: Land

ALLOWED: one.txt

## Step 2: Change nothing

ALLOWED: two.txt

## Step 3: Never reached

ALLOWED: three.txt
`;

  it("lists landed, failed, and skipped steps, and stops at the first failure", () => {
    const target = makeTarget();
    const r = runLoop(target, writeSteps(threeSteps), {
      plan: [{ do: "write", path: "one.txt", content: "1\n" }, { do: "nothing" }],
      extra: ["--attempts", "1"],
    });

    expect(r.code).toBe(1);
    expect(r.calls).toBe(2);
    expect(r.report).toMatch(/\| 1 \| Step 1: Land \| landed \| 1 \| 1 \| \$0\.01 \|  \| `[0-9a-f]{7}` \| `one.txt` \+1 -0 \|/);
    expect(r.report).toMatch(/\| 2 \| Step 2: Change nothing \| failed \| 1 \| 1 \| \$0\.01 \| no changes \|/);
    expect(r.report).toMatch(/\| 3 \| Step 3: Never reached \| skipped \| 0 \| - \| - \|/);
    expect(r.report).toContain("(1 landed, 1 failed, 1 skipped, 3 total)");
    expect(r.report).toContain("| Total cost | $0.02 |");
  });

  it("keeps going past a failed step with --continue-on-fail", () => {
    const target = makeTarget();
    const r = runLoop(target, writeSteps(threeSteps), {
      plan: [{ do: "write", path: "one.txt", content: "1\n" }, { do: "nothing" }, { do: "write", path: "three.txt", content: "3\n" }],
      extra: ["--attempts", "1", "--continue-on-fail"],
    });

    expect(r.code).toBe(1);
    expect(r.report).toContain("Outcome: **finished with failures**");
    expect(r.report).toMatch(/\| 3 \| Step 3: Never reached \| landed \| 1 \|/);
    expect(sh(target, "git", ["log", "--format=%s", `main..${r.branch}`])).toBe("loop: Step 3: Never reached\nloop: Step 1: Land");
  });

  it("builds on a loop branch as the base and tells the truth about taking it", () => {
    const target = makeTarget();
    const first = runLoop(target, writeSteps(stepsGreen), { plan: [{ do: "write", path: "notes/first.md", content: "1\n" }] });
    expect(first.code).toBe(0);

    spawnSync("sleep", ["1.1"]);
    const second = runLoop(target, writeSteps(stepsGreen), {
      plan: [{ do: "write", path: "notes/second.md", content: "2\n" }],
      extra: ["--base", first.branch],
    });
    expect(second.code).toBe(0);

    // Cut from the first run's branch: its parent is that branch's tip, and it carries both commits.
    expect(sh(target, "git", ["rev-parse", `${second.branch}~1`])).toBe(sh(target, "git", ["rev-parse", first.branch]));
    expect(sh(target, "git", ["rev-list", "--count", `main..${second.branch}`])).toBe("2");
    expect(second.report).toContain(`| Base | \`${first.branch}\` at \`${sh(target, "git", ["rev-parse", first.branch]).slice(0, 12)}\` |`);
    expect(second.report).toContain(`git -C ${target} diff ${first.branch}..${second.branch}`);
    expect(second.report).toContain(`This branch is built on \`${first.branch}\``);
    expect(second.report).toContain(`git -C ${target} merge --ff-only ${second.branch}`);

    // Move main past the branch point, then stack a third run: fast-forward no longer works, and the report says so.
    fs.writeFileSync(path.join(target, "main-only.txt"), "moved\n");
    sh(target, "git", ["add", "-A"]);
    sh(target, "git", ["commit", "-q", "-m", "main moves on"]);
    spawnSync("sleep", ["1.1"]);
    const third = runLoop(target, writeSteps(stepsGreen), {
      plan: [{ do: "write", path: "notes/third.md", content: "3\n" }],
      extra: ["--base", second.branch],
    });
    expect(third.code).toBe(0);
    expect(third.report).toContain("had commits this branch does not, so a fast-forward will not work");
    expect(third.report).toContain(`git -C ${target} merge ${third.branch}\n`);
    expect(third.report).not.toContain("--ff-only");

    // And the advice works.
    sh(target, "git", ["merge", "-q", "--no-edit", third.branch]);
    expect(sh(target, "git", ["rev-list", "--count", `main..${third.branch}`])).toBe("0");
    expect(sh(target, "git", ["log", "--format=%s", "main"]).split("\n").filter((l) => l.startsWith("loop: "))).toHaveLength(3);
  });

  it("dry-runs without calling Claude, then clean removes the merged worktree and keeps unmerged ones", () => {
    const target = makeTarget();
    const dry = runLoop(target, writeSteps(threeSteps), { extra: ["--dry-run"] });

    expect(dry.code).toBe(0);
    expect(dry.calls).toBe(0);
    expect(dry.stdout).toContain("===== step 1 prompt (dry run) =====");
    expect(dry.stdout).toContain("===== step 3 prompt (dry run) =====");
    expect(dry.report).toContain("(0 landed, 0 failed, 3 skipped, 3 total)");
    const dryWorktree = dry.report.match(/\| Worktree \| `([^`]+)` \|/)[1];
    expect(fs.existsSync(dryWorktree)).toBe(true);

    // A second run that lands a commit, so its branch is not merged into main.
    spawnSync("sleep", ["1.1"]);
    const real = runLoop(target, writeSteps(stepsGreen), { plan: [{ do: "write", path: "notes/b.md", content: "b\n" }] });
    expect(real.code).toBe(0);
    const realWorktree = real.report.match(/\| Worktree \| `([^`]+)` \|/)[1];

    const cleaned = spawnSync("node", [BIN, "clean", "--target", target], {
      encoding: "utf8",
      env: { ...process.env, BUILD_LOOP_HOME: path.join(tmp, "state") },
    });
    expect(cleaned.status).toBe(0);
    expect(cleaned.stdout).toContain(`removed  ${dryWorktree}`);
    expect(cleaned.stdout).toContain(`kept     ${realWorktree}`);
    expect(fs.existsSync(dryWorktree)).toBe(false);
    expect(fs.existsSync(realWorktree)).toBe(true);
    expect(fs.existsSync(dry.reportPath)).toBe(true);
    expect(sh(target, "git", ["status", "--porcelain"])).toBe("");
  });
});
