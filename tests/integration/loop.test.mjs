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
const status = fs.readFileSync("status.txt", "utf8");
console.log("SECRET_TOKEN=" + (process.env.SECRET_TOKEN ?? "absent"));
// An ignored cache file that short-circuits the gate, to test that ignored files are cleaned first.
if (fs.existsSync("cache/pass")) {
  console.log("cache says pass");
  process.exit(0);
}
// "spill" makes the gate itself write files, to test checks that run after it.
if (status.includes("spill-control")) {
  fs.mkdirSync("notes", { recursive: true });
  fs.writeFileSync("notes/out.md", "color \\u001b[0m\\n");
} else if (status.includes("spill")) {
  fs.writeFileSync("gate-output.txt", "made by the gate\\n");
}
// "revert" makes the gate undo the attempt's only change.
if (status.includes("revert")) fs.writeFileSync("status.txt", "green\\n");
if (status.includes("red")) {
  console.log("CHECK SAYS RED MARKER");
  process.exit(1);
}
console.log("check passed");
`
  );
  fs.writeFileSync(path.join(repo, "status.txt"), `${status}\n`);
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\ncache/\n");
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
        BUILD_LOOP_MACHINE: "test-machine",
        BUILD_LOOP_PASS_ENV: "FAKE_CLAUDE_STATE,FAKE_CLAUDE_PLAN",
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
    expect(r.branch).toMatch(/^loop\/\d{8}-\d{6}-[0-9a-f]{6}$/);
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

  it("runs two same-named targets started together without sharing a run id, temp folder, or worktree", async () => {
    const { spawn } = await import("node:child_process");
    const home = path.join(tmp, "state");
    const start = (target, n) => {
      const fakeState = path.join(tmp, `fake-${n}`);
      fs.mkdirSync(fakeState, { recursive: true });
      const child = spawn("node", [BIN, "--target", target, "--steps", writeSteps(stepsGreen), "--install", "true", "--claude-cmd", FAKE], {
        env: {
          ...process.env,
          BUILD_LOOP_HOME: home,
          BUILD_LOOP_MACHINE: "test-machine",
          BUILD_LOOP_PASS_ENV: "FAKE_CLAUDE_STATE,FAKE_CLAUDE_PLAN",
          FAKE_CLAUDE_STATE: fakeState,
          FAKE_CLAUDE_PLAN: JSON.stringify([{ do: "write", path: `notes/${n}.md`, content: `${n}\n` }]),
        },
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      return new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout, fakeState })));
    };
    // Same folder name in two places: the run folders are keyed by that name.
    const targets = ["a", "b"].map((side) => {
      const parent = path.join(tmp, side);
      fs.mkdirSync(parent);
      const t = makeTarget();
      fs.renameSync(t, path.join(parent, "target-app"));
      return path.join(parent, "target-app");
    });
    const [one, two] = await Promise.all([start(targets[0], "one"), start(targets[1], "two")]);
    expect(one.code).toBe(0);
    expect(two.code).toBe(0);
    const branchOf = (r) => r.stdout.trim().split("\n").at(-1);
    expect(branchOf(one)).not.toBe(branchOf(two));
    expect(fs.readdirSync(path.join(home, "runs", "target-app"))).toHaveLength(2);
    const tmpOf = (r) => JSON.parse(fs.readFileSync(path.join(r.fakeState, "env-1.json"), "utf8")).TMPDIR;
    expect(tmpOf(one)).not.toBe(tmpOf(two));
  });

  it("records where the run happened and snapshots the steps file", () => {
    const target = makeTarget();
    sh(target, "git", ["remote", "add", "origin", "https://example.com/me/target-app.git"]);
    const stepsPath = writeSteps(stepsGreen);
    const r = runLoop(target, stepsPath, { plan: [{ do: "write", path: "notes/a.md", content: "hi\n" }] });
    expect(r.code).toBe(0);

    // Editing the steps file afterwards must not change what the run recorded.
    fs.writeFileSync(stepsPath, "## Something else entirely\n");

    const state = JSON.parse(fs.readFileSync(path.join(r.runDir, "state.json"), "utf8"));
    expect(state.schemaVersion).toBe(2);
    expect(state.runId).toBe(r.branch.replace("loop/", ""));
    expect(state.machine).toMatchObject({ name: "test-machine", source: "BUILD_LOOP_MACHINE" });
    expect(state.machine.hostname).toBe(os.hostname());
    expect(state.repo.origin).toBe("https://example.com/me/target-app.git");
    expect(state.startedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(state.endedAtUtc)).toBeGreaterThanOrEqual(Date.parse(state.startedAtUtc));
    expect(state.runner.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(state.versions.node).toBe(process.version);
    expect(state.versions.claude).toContain("custom command:");
    expect(fs.readFileSync(path.join(r.runDir, "steps.md"), "utf8")).toBe(stepsGreen);
    expect(state.stepsFile).toMatchObject({ source: stepsPath, snapshot: "steps.md" });
    expect(state.stepsFile.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.report).toContain("| Machine | test-machine (");
    expect(r.report).toContain("(https://example.com/me/target-app.git)");
  });

  describe("sandbox", () => {
    // Each case also runs with --no-sandbox, to prove the attempt would otherwise succeed.
    const stepsAnyFile = `## Step 1: Anything\n\nDo it.\n`;

    it("stops Claude writing into the target checkout", () => {
      const target = makeTarget();
      const escaped = path.join(target, "escaped.txt");
      const sandboxed = runLoop(target, writeSteps(stepsAnyFile), { plan: [{ do: "write", path: escaped, content: "out\n" }], extra: ["--attempts", "1"] });
      expect(sandboxed.code).toBe(1);
      expect(fs.existsSync(escaped)).toBe(false);
      expect(sandboxed.report).toContain("| Sandbox | on:");

      spawnSync("sleep", ["1.1"]);
      const open = runLoop(target, writeSteps(stepsAnyFile), { plan: [{ do: "write", path: escaped, content: "out\n" }], extra: ["--attempts", "1", "--no-sandbox"] });
      expect(fs.existsSync(escaped)).toBe(true);
      expect(open.report).toContain("| Sandbox | **off:");
      expect(open.stdout).toContain("WARNING: running without the sandbox");
    });

    it("stops Claude reading a secret from the target checkout", () => {
      const target = makeTarget();
      fs.writeFileSync(path.join(target, ".env.local"), "TOKEN=hunter2\n");
      fs.appendFileSync(path.join(target, ".git", "info", "exclude"), ".env.local\n");
      const plan = [{ do: "copy", from: path.join(target, ".env.local"), to: "leak.txt" }];

      const sandboxed = runLoop(target, writeSteps(stepsAnyFile), { plan, extra: ["--attempts", "1"] });
      expect(sandboxed.code).toBe(1);
      expect(sandboxed.report).toMatch(/\| failed \| 1 \|.*no changes/);
      expect(sh(target, "git", ["log", "--all", "--format=%H", "--", "leak.txt"])).toBe("");

      spawnSync("sleep", ["1.1"]);
      const open = runLoop(target, writeSteps(stepsAnyFile), { plan, extra: ["--attempts", "1", "--no-sandbox"] });
      expect(open.code).toBe(0);
      expect(sh(target, "git", ["show", `${open.branch}:leak.txt`])).toBe("TOKEN=hunter2");
    });

    it("stops Claude changing installed dependencies", () => {
      const target = makeTarget();
      const plan = [{ do: "write", path: "node_modules/tool/index.js", content: "tampered\n" }];
      const install = ["--install", "mkdir -p node_modules/tool && echo original > node_modules/tool/index.js"];
      const toolIn = (r) => fs.readFileSync(path.join(r.report.match(/\| Worktree \| `([^`]+)` \|/)[1], "node_modules/tool/index.js"), "utf8");

      const sandboxed = runLoop(target, writeSteps(stepsAnyFile), { plan, extra: ["--attempts", "1", ...install] });
      expect(toolIn(sandboxed)).toBe("original\n");

      spawnSync("sleep", ["1.1"]);
      const open = runLoop(target, writeSteps(stepsAnyFile), { plan, extra: ["--attempts", "1", "--no-sandbox", ...install] });
      expect(toolIn(open)).toBe("tampered\n");
    });

    it("runs the gate sandboxed too, so a test cannot write outside the worktree", () => {
      const target = makeTarget();
      const escaped = path.join(target, "from-the-gate.txt");
      const check = `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(escaped)}, "gate was here\\n");\n`;
      const plan = [{ do: "write", path: "check.mjs", content: check }];

      const sandboxed = runLoop(target, writeSteps(stepsAnyFile), { plan, extra: ["--attempts", "1"] });
      expect(sandboxed.code).toBe(1);
      expect(sandboxed.report).toMatch(/\| failed \| 1 \|.*\| gate \|/);
      expect(sandboxed.report).toContain("EPERM");
      expect(fs.existsSync(escaped)).toBe(false);

      spawnSync("sleep", ["1.1"]);
      runLoop(target, writeSteps(stepsAnyFile), { plan, extra: ["--attempts", "1", "--no-sandbox"] });
      expect(fs.existsSync(escaped)).toBe(true);
    });
  });

  describe("second review fixes", () => {
    const stepsAnyFile = `## Step 1: Anything\n\nDo it.\n`;
    const worktreeOf = (r) => r.report.match(/\| Worktree \| `([^`]+)` \|/)[1];

    it("refuses to run when install changes files in the worktree", () => {
      const target = makeTarget();
      const r = runLoop(target, writeSteps(stepsGreen), { extra: ["--install", "echo made > generated.txt"] });
      expect(r.code).toBe(1);
      expect(r.calls).toBe(0);
      expect(r.report).toContain("Outcome: **refused**. install changed files in the worktree (generated.txt)");
    });

    it("refuses to run when the baseline gate changes files in the worktree", () => {
      const target = makeTarget({ status: "green spill" });
      const r = runLoop(target, writeSteps(stepsGreen));
      expect(r.code).toBe(1);
      expect(r.calls).toBe(0);
      expect(r.report).toContain("the baseline gate changed files in the worktree (gate-output.txt)");
    });

    it("stops a hanging gate at its time limit and reports a gate timeout", () => {
      const target = makeTarget();
      const r = runLoop(target, writeSteps(stepsAnyFile), {
        plan: [{ do: "write", path: "check.mjs", content: "while (true) {}\n" }],
        extra: ["--attempts", "1", "--gate-timeout", "0.05"],
      });
      expect(r.code).toBe(1);
      expect(r.elapsedMs).toBeLessThan(40000);
      expect(r.report).toMatch(/\| failed \| 1 \|.*\| gate timeout \|/);
    });

    it("stops a hanging install at its time limit", () => {
      const target = makeTarget();
      const r = runLoop(target, writeSteps(stepsGreen), { extra: ["--install", "sleep 60", "--install-timeout", "0.03"] });
      expect(r.code).toBe(1);
      expect(r.elapsedMs).toBeLessThan(40000);
      expect(r.report).toContain("install failed: `sleep 60` timed out");
    });

    it("cleans ignored files before the gate, so a planted cache cannot turn it green", () => {
      const target = makeTarget();
      const r = runLoop(target, writeSteps(stepsGreen), {
        plan: [{ do: "multi", actions: [{ do: "write", path: "status.txt", content: "red\n" }, { do: "write", path: "cache/pass", content: "yes\n" }] }],
        extra: ["--attempts", "1"],
      });
      expect(r.code).toBe(1);
      expect(r.report).toMatch(/\| failed \| 1 \|.*\| gate \|/);
      expect(sh(target, "git", ["rev-list", "--count", `main..${r.branch}`])).toBe("0");
      expect(fs.existsSync(path.join(worktreeOf(r), "cache"))).toBe(false);
    });

    it("commits with git hooks disabled, so a hook cannot add files or run outside the sandbox", () => {
      const target = makeTarget();
      const escaped = path.join(tmp, "hook-escaped.txt");
      fs.mkdirSync(path.join(target, ".githooks"));
      fs.writeFileSync(path.join(target, ".githooks", "pre-commit"), "#!/bin/sh\necho forbidden > forbidden.txt\ngit add forbidden.txt\n");
      fs.writeFileSync(path.join(target, ".githooks", "post-commit"), `#!/bin/sh\necho out > ${JSON.stringify(escaped)}\n`);
      fs.chmodSync(path.join(target, ".githooks", "pre-commit"), 0o755);
      fs.chmodSync(path.join(target, ".githooks", "post-commit"), 0o755);
      sh(target, "git", ["add", "-A"]);
      sh(target, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "hooks"]);
      sh(target, "git", ["config", "core.hooksPath", ".githooks"]);

      const r = runLoop(target, writeSteps(stepsGreen), { plan: [{ do: "write", path: "status.txt", content: "green again\n" }] });
      expect(r.code).toBe(0);
      expect(sh(target, "git", ["diff", "--name-only", `main..${r.branch}`])).toBe("status.txt");
      expect(fs.existsSync(escaped)).toBe(false);
    });

    it("does not pass the runner's environment to Claude or the gate, except names passed on purpose", () => {
      const target = makeTarget();
      const r = runLoop(target, writeSteps(stepsGreen), {
        plan: [{ do: "write", path: "status.txt", content: "green again\n" }],
        stateEnv: { SECRET_TOKEN: "hunter2", GITHUB_TOKEN: "ghp-nope" },
      });
      expect(r.code).toBe(0);
      const seen = JSON.parse(fs.readFileSync(path.join(r.fakeState, "env-1.json"), "utf8"));
      expect(seen.SECRET_TOKEN).toBeNull();
      expect(seen.keys).not.toContain("GITHUB_TOKEN");
      expect(fs.readFileSync(path.join(r.runDir, "baseline.gate.log"), "utf8")).toContain("SECRET_TOKEN=absent");

      spawnSync("sleep", ["1.1"]);
      const passed = runLoop(target, writeSteps(stepsGreen), {
        plan: [{ do: "write", path: "status.txt", content: "green third\n" }],
        stateEnv: { SECRET_TOKEN: "hunter2", BUILD_LOOP_PASS_ENV: "FAKE_CLAUDE_STATE,FAKE_CLAUDE_PLAN,SECRET_TOKEN" },
      });
      expect(fs.readFileSync(path.join(passed.runDir, "baseline.gate.log"), "utf8")).toContain("SECRET_TOKEN=hunter2");
    });

    it("runs the install sandboxed, so install scripts cannot write outside the worktree", () => {
      const target = makeTarget();
      const escaped = path.join(target, "from-install.txt");
      const sandboxed = runLoop(target, writeSteps(stepsGreen), { extra: ["--install", `echo out > ${JSON.stringify(escaped)}`] });
      expect(sandboxed.code).toBe(1);
      expect(sandboxed.report).toContain("install failed");
      expect(fs.existsSync(escaped)).toBe(false);

      spawnSync("sleep", ["1.1"]);
      runLoop(target, writeSteps(stepsGreen), { plan: [{ do: "nothing" }], extra: ["--attempts", "1", "--no-sandbox", "--install", `echo out > ${JSON.stringify(escaped)}`] });
      expect(fs.existsSync(escaped)).toBe(true);
    });

    it("denies writes outside the home folder and to ~/.claude.json", () => {
      const tag = `build-loop-test-${process.pid}-${Date.now()}`;
      const shared = fs.existsSync("/Users/Shared") ? path.join("/Users/Shared", `${tag}.txt`) : null;
      const claudeJson = path.join(os.homedir(), `.claude.json.${tag}`);
      const target = makeTarget();
      const writes = [{ do: "write", path: claudeJson, content: "{}\n" }];
      if (shared) writes.unshift({ do: "write", path: shared, content: "x\n" });
      try {
        for (const w of writes) {
          runLoop(target, writeSteps(stepsAnyFile), { plan: [w], extra: ["--attempts", "1"] });
          expect(fs.existsSync(w.path), w.path).toBe(false);
          spawnSync("sleep", ["1.1"]);
        }
      } finally {
        for (const w of writes) fs.rmSync(w.path, { force: true });
      }
    });

    it("kills a child that detached into its own process group", () => {
      const target = makeTarget();
      const r = runLoop(target, writeSteps(stepsGreen), {
        plan: [{ do: "orphan", path: "late.md", ms: 2500, detached: true }],
        extra: ["--attempts", "1"],
      });
      const late = fs.readFileSync(path.join(r.fakeState, "orphan-1.txt"), "utf8");
      spawnSync("sleep", ["3.5"]);
      expect(fs.existsSync(late)).toBe(false);
    });

    it("ignores the runner's TMPDIR: children get a per-run temp folder and cannot write the old one", () => {
      const wide = fs.mkdtempSync(path.join(os.homedir(), ".build-loop-test-wide-tmp-"));
      try {
        const target = makeTarget();
        const r = runLoop(target, writeSteps(stepsAnyFile), {
          plan: [{ do: "write", path: path.join(wide, "escaped.txt"), content: "x\n" }],
          extra: ["--attempts", "1"],
          stateEnv: { TMPDIR: wide },
        });
        expect(fs.existsSync(path.join(wide, "escaped.txt"))).toBe(false);
        const seen = JSON.parse(fs.readFileSync(path.join(r.fakeState, "env-1.json"), "utf8"));
        expect(seen.TMPDIR).toBe(path.join(tmp, "state", "tmp", r.branch.replace("loop/", "")));
        expect(fs.readFileSync(path.join(r.runDir, "sandbox-gate.sb"), "utf8")).not.toContain(wide);
        expect(fs.existsSync(seen.TMPDIR)).toBe(false);
      } finally {
        fs.rmSync(wide, { recursive: true, force: true });
      }
    });

    it("cleans ignored files before the baseline gate, so install cannot plant a green baseline", () => {
      const target = makeTarget({ status: "red" });
      const r = runLoop(target, writeSteps(stepsGreen), { extra: ["--install", "mkdir -p cache && echo yes > cache/pass"] });
      expect(r.code).toBe(1);
      expect(r.calls).toBe(0);
      expect(r.report).toContain("Outcome: **refused**. baseline red");
    });

    it("refuses a step with an empty ALLOWED line", () => {
      const target = makeTarget();
      const r = runLoop(target, writeSteps("## Step 1: Nothing listed\n\nDo it.\n\nALLOWED:\n"));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("step 1 has an ALLOWED: line with no paths");
    });

    it("kills detached children when the runner is interrupted", async () => {
      const target = makeTarget();
      const home = path.join(tmp, "state");
      const fakeState = path.join(tmp, "fake-int");
      fs.mkdirSync(fakeState, { recursive: true });
      const { spawn } = await import("node:child_process");
      const plan = [{ do: "multi", actions: [{ do: "orphan", path: "late.md", ms: 4000, detached: true }, { do: "sleep", ms: 60000 }] }];
      const runner = spawn("node", [BIN, "--target", target, "--steps", writeSteps(stepsGreen), "--install", "true", "--claude-cmd", FAKE, "--attempts", "1"], {
        env: { ...process.env, BUILD_LOOP_HOME: home, BUILD_LOOP_MACHINE: "test-machine", BUILD_LOOP_PASS_ENV: "FAKE_CLAUDE_STATE,FAKE_CLAUDE_PLAN", FAKE_CLAUDE_STATE: fakeState, FAKE_CLAUDE_PLAN: JSON.stringify(plan) },
        stdio: "ignore",
      });
      for (let i = 0; i < 150 && !fs.existsSync(path.join(fakeState, "orphan-1.txt")); i++) await new Promise((r) => setTimeout(r, 100));
      const late = fs.readFileSync(path.join(fakeState, "orphan-1.txt"), "utf8");
      runner.kill("SIGINT");
      await new Promise((resolve) => runner.on("exit", resolve));
      await new Promise((r) => setTimeout(r, 5000));
      expect(fs.existsSync(late)).toBe(false);
    });

    it("cuts the worktree from the recorded base commit", () => {
      const target = makeTarget();
      const r = runLoop(target, writeSteps(stepsGreen), { plan: [{ do: "write", path: "notes/x.md", content: "x\n" }] });
      const state = JSON.parse(fs.readFileSync(path.join(r.runDir, "state.json"), "utf8"));
      expect(sh(target, "git", ["rev-parse", `${r.branch}~1`])).toBe(state.baseCommit);
      expect(r.report).toContain(`diff ${state.baseCommit}..${r.branch}`);
    });
  });

  describe("gate protection", () => {
    const stepsAnyFile = `## Step 1: Anything\n\nDo it.\n`;
    const pkgWith = (check) => JSON.stringify({ name: "target-app", private: true, scripts: { check, dev: "node dev.mjs" } }, null, 2);

    it("fails an attempt that replaces scripts.check, even with no ALLOWED list", () => {
      const target = makeTarget();
      const r = runLoop(target, writeSteps(stepsAnyFile), {
        plan: [{ do: "multi", actions: [{ do: "write", path: "package.json", content: pkgWith("true") }, { do: "write", path: "status.txt", content: "red\n" }] }],
        extra: ["--attempts", "2"],
      });
      expect(r.code).toBe(1);
      expect(r.calls).toBe(2);
      expect(r.stdout).toContain("step 1 attempt 1 changed the gate: package.json scripts.check");
      expect(r.report).toMatch(/\| failed \| 2 \|.*gate changed: package.json scripts.check \|/);
      expect(fs.existsSync(path.join(r.runDir, "step-1-attempt-1.gate.log"))).toBe(false);
      const second = fs.readFileSync(path.join(r.fakeState, "prompt-2.txt"), "utf8");
      expect(second).toContain("It changed the gate");
      expect(second).toContain("- package.json scripts.check");
      expect(sh(target, "git", ["rev-list", "--count", `main..${r.branch}`])).toBe("0");
    });

    it("still lands a package.json change that leaves the gate scripts alone", () => {
      const target = makeTarget();
      const r = runLoop(target, writeSteps(stepsAnyFile), { plan: [{ do: "write", path: "package.json", content: pkgWith("node check.mjs") }] });
      expect(r.code).toBe(0);
      expect(sh(target, "git", ["diff", "--name-only", `main..${r.branch}`])).toBe("package.json");
    });

    it("fails an attempt that changes a PROTECTED path from the steps file", () => {
      const target = makeTarget();
      const steps = `# Run\n\nPROTECTED: check.mjs\n\n## Step 1: Anything\n\nDo it.\n`;
      const r = runLoop(target, writeSteps(steps), {
        plan: [{ do: "multi", actions: [{ do: "write", path: "check.mjs", content: "process.exit(0);\n" }, { do: "write", path: "status.txt", content: "red\n" }] }],
        extra: ["--attempts", "1"],
      });
      expect(r.code).toBe(1);
      expect(r.report).toMatch(/\| failed \| 1 \|.*gate changed: check.mjs \|/);
      expect(fs.readFileSync(path.join(r.fakeState, "prompt-1.txt"), "utf8")).toContain("These paths are part of the gate. Changing any of them fails the attempt:\n\n- check.mjs");
    });
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

  it("resets staged changes too when a step runs out of attempts", () => {
    const target = makeTarget();
    const r = runLoop(target, writeSteps(stepsGreen), {
      plan: [{ do: "stage", path: "status.txt", content: "red\n" }],
      extra: ["--attempts", "1", "--no-sandbox"],
    });
    expect(r.code).toBe(1);
    expect(r.report).toMatch(/\| failed \| 1 \|.*\| gate \|/);
    const worktree = r.report.match(/\| Worktree \| `([^`]+)` \|/)[1];
    expect(sh(worktree, "git", ["status", "--porcelain"])).toBe("");
    expect(fs.readFileSync(path.join(worktree, "status.txt"), "utf8")).toBe("green\n");
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

  it("fails an attempt whose gate writes a file outside ALLOWED, instead of committing it", () => {
    const target = makeTarget();
    const r = runLoop(target, writeSteps(stepsGreen), {
      plan: [{ do: "write", path: "status.txt", content: "green spill\n" }],
      extra: ["--attempts", "1"],
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("out of scope after the gate: gate-output.txt");
    expect(r.report).toMatch(/\| failed \| 1 \|.*scope: gate-output.txt/);
    expect(sh(target, "git", ["rev-list", "--count", `main..${r.branch}`])).toBe("0");
  });

  it("fails an attempt whose gate writes an unreadable file inside ALLOWED", () => {
    const target = makeTarget();
    const r = runLoop(target, writeSteps(stepsGreen), {
      plan: [{ do: "write", path: "status.txt", content: "green spill-control\n" }],
      extra: ["--attempts", "1"],
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("unreviewable after the gate: notes/out.md line 1 (0x1b)");
    expect(sh(target, "git", ["rev-list", "--count", `main..${r.branch}`])).toBe("0");
  });

  it("retries with no changes when the gate removes the attempt's only change", () => {
    const target = makeTarget();
    const r = runLoop(target, writeSteps(stepsGreen), {
      plan: [{ do: "write", path: "status.txt", content: "green revert\n" }, { do: "write", path: "notes/real.md", content: "real\n" }],
    });
    expect(r.stdout).not.toContain("error:");
    expect(r.stdout).toContain("step 1 attempt 1 has no changes left after the gate");
    expect(r.code).toBe(0);
    expect(r.calls).toBe(2);
    expect(fs.readFileSync(path.join(r.fakeState, "prompt-2.txt"), "utf8")).toContain("changed no files");
    const state = JSON.parse(fs.readFileSync(path.join(r.runDir, "state.json"), "utf8"));
    expect(state.steps[0].attempts[0].reason).toBe("no changes");
    expect(sh(target, "git", ["diff", "--name-only", `main..${r.branch}`])).toBe("notes/real.md");
  });

  it("kills background children a Claude process leaves behind", () => {
    const target = makeTarget();
    const r = runLoop(target, writeSteps(stepsGreen), {
      plan: [{ do: "orphan", path: "late.md", ms: 2000 }],
      extra: ["--attempts", "1"],
    });
    expect(r.report).toMatch(/\| failed \| 1 \|.*no changes/);
    const late = fs.readFileSync(path.join(r.fakeState, "orphan-1.txt"), "utf8");
    spawnSync("sleep", ["3"]);
    expect(fs.existsSync(late)).toBe(false);
  });

  for (const sandbox of [true, false]) {
    it(`stops at once with the launch error when the Claude command does not exist (${sandbox ? "sandboxed" : "no sandbox"})`, () => {
      const target = makeTarget();
      const missing = path.join(tmp, "no-such-claude");
      const r = runLoop(target, writeSteps(stepsGreen), { extra: ["--attempts", "3", "--continue-on-fail", "--claude-cmd", missing, ...(sandbox ? [] : ["--no-sandbox"])] });
      expect(r.stderr).not.toContain("EBADF");
      expect(r.code).toBe(1);
      expect(r.report).toContain("Outcome: **failed**. Claude could not be started:");
      expect(r.report).toContain(missing);
      expect(r.report).toMatch(/\| 1 \| Step 1: Make it green \| failed \| 1 \|.*launch error: .*(ENOENT|No such file)/);
      const state = JSON.parse(fs.readFileSync(path.join(r.runDir, "state.json"), "utf8"));
      expect(state.steps[0].attempts).toHaveLength(1);
      expect(state.steps[0].attempts[0].reason).toBe("launch error");
      expect(state.steps[0].attempts[0].launchError).toMatch(/ENOENT|No such file/);
    });
  }

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
    expect(second.report).toContain(`git -C ${target} diff ${sh(target, "git", ["rev-parse", first.branch])}..${second.branch}`);
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

  it("indexes runs and tells taken, pending, discarded, and nothing-to-take apart", () => {
    const target = makeTarget();
    const home = path.join(tmp, "state");
    const runs = (machine = "test-machine") => {
      const r = spawnSync("node", [BIN, "runs"], { encoding: "utf8", env: { ...process.env, BUILD_LOOP_HOME: home, BUILD_LOOP_MACHINE: machine } });
      expect(r.status).toBe(0);
      const rows = fs.readFileSync(path.join(home, "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      return { stdout: r.stdout, byRun: Object.fromEntries(rows.map((row) => [row.runId, row])) };
    };

    const dry = runLoop(target, writeSteps(stepsGreen), { extra: ["--dry-run"] });
    spawnSync("sleep", ["1.1"]);
    const kept = runLoop(target, writeSteps(stepsGreen), { plan: [{ do: "write", path: "notes/kept.md", content: "k\n" }] });
    spawnSync("sleep", ["1.1"]);
    const tossed = runLoop(target, writeSteps(stepsGreen), { plan: [{ do: "write", path: "notes/tossed.md", content: "t\n" }] });
    const id = (r) => r.branch.replace("loop/", "");

    let index = runs();
    expect(index.byRun[id(dry)].decision).toBe("nothing to take");
    expect(index.byRun[id(kept)].decision).toBe("pending");
    expect(index.byRun[id(tossed)].decision).toBe("pending");
    expect(index.byRun[id(kept)].key).toBe(`test-machine/target-app/${id(kept)}`);
    expect(index.stdout).toContain("3 run(s) indexed on test-machine; decisions checked against main");

    // Take one, discard the other the way the report says to.
    sh(target, "git", ["merge", "-q", "--ff-only", kept.branch]);
    const tossedWorktree = tossed.report.match(/\| Worktree \| `([^`]+)` \|/)[1];
    sh(target, "git", ["worktree", "remove", "--force", tossedWorktree]);
    sh(target, "git", ["branch", "-D", tossed.branch]);

    index = runs();
    expect(index.byRun[id(kept)]).toMatchObject({ decision: "taken", decisionDetail: "in main" });
    expect(index.byRun[id(tossed)]).toMatchObject({ decision: "discarded", decisionDetail: "branch deleted without merging" });
    expect(index.stdout).toMatch(new RegExp(`${id(kept)}\\s+test-machine\\s+target-app\\s+all steps landed\\s+1/1\\s+\\$0\\.01\\s+taken`));

    // Indexed from another machine, the decision is not guessed.
    index = runs("somewhere-else");
    expect(index.byRun[id(kept)]).toMatchObject({ decision: "unknown", decidedOn: "somewhere-else" });
  });

  it("clean keeps a run that is still in progress and a worktree with uncommitted changes", async () => {
    const target = makeTarget();
    const home = path.join(tmp, "state");
    const fakeState = path.join(tmp, "fake-live");
    fs.mkdirSync(fakeState, { recursive: true });
    const { spawn } = await import("node:child_process");
    const live = spawn("node", [BIN, "--target", target, "--steps", writeSteps(stepsGreen), "--install", "true", "--claude-cmd", FAKE, "--attempts", "1", "--timeout", "0.1"], {
      env: { ...process.env, BUILD_LOOP_HOME: home, BUILD_LOOP_MACHINE: "test-machine", BUILD_LOOP_PASS_ENV: "FAKE_CLAUDE_STATE,FAKE_CLAUDE_PLAN", FAKE_CLAUDE_STATE: fakeState, FAKE_CLAUDE_PLAN: JSON.stringify([{ do: "sleep", ms: 60000 }]) },
      stdio: "ignore",
    });
    const cleanNow = () =>
      spawnSync("node", [BIN, "clean", "--target", target], { encoding: "utf8", env: { ...process.env, BUILD_LOOP_HOME: home, BUILD_LOOP_MACHINE: "test-machine" } });

    // Wait until the run is inside its Claude call, with its branch still at the base.
    for (let i = 0; i < 100 && !fs.existsSync(path.join(fakeState, "calls")); i++) await new Promise((r) => setTimeout(r, 100));
    const worktree = fs.readdirSync(path.join(home, "worktrees", "target-app")).map((d) => path.join(home, "worktrees", "target-app", d))[0];
    let cleaned = cleanNow();
    expect(cleaned.stdout).toContain(`kept     ${worktree} (run in progress, pid `);
    expect(fs.existsSync(worktree)).toBe(true);

    await new Promise((resolve) => live.on("exit", resolve));
    fs.writeFileSync(path.join(worktree, "scratch.txt"), "mine\n");
    cleaned = cleanNow();
    expect(cleaned.stdout).toContain(`kept     ${worktree} (uncommitted changes in the worktree)`);

    fs.rmSync(path.join(worktree, "scratch.txt"));
    cleaned = cleanNow();
    expect(cleaned.stdout).toContain(`removed  ${worktree}`);
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
