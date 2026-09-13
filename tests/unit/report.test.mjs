import { describe, expect, it } from "vitest";
import { runId, runPaths } from "../../src/paths.mjs";
import { renderReport, totalCost } from "../../src/report.mjs";

const state = {
  target: "/Users/me/app",
  base: "main",
  baseCommit: "8b9d3201234567890",
  branch: "loop/20260912-213000",
  worktree: "/Users/me/.build-loop/worktrees/app/20260912-213000",
  runDir: "/Users/me/.build-loop/runs/app/20260912-213000",
  model: "sonnet",
  dryRun: false,
  startedAt: "2026-09-12T21:30:00",
  endedAt: "2026-09-12T21:40:00",
  outcome: "stopped",
  stopReason: "Step 2 failed after 3 attempts",
  steps: [
    {
      index: 1,
      heading: "Step 1: Add PUT",
      status: "landed",
      attemptsUsed: 1,
      reason: null,
      commit: "abc1234def",
      files: [
        { path: "app/api/log/route.js", added: 30, removed: 2 },
        { path: "img.png", added: null, removed: null },
      ],
      costUsd: 0.5,
    },
    {
      index: 2,
      heading: "Step 2: Fix | component",
      status: "failed",
      attemptsUsed: 3,
      reason: "gate",
      commit: null,
      files: [],
      gateTail: "FAIL tests/unit/x.test.js",
      costUsd: 1.25,
    },
    { index: 3, heading: "Step 3: Log", status: "skipped", attemptsUsed: 0, reason: null, commit: null, files: [], costUsd: null },
  ],
};

describe("renderReport", () => {
  const md = renderReport(state);

  it("summarizes the run and its total cost", () => {
    expect(md).toContain("# build-loop report: loop/20260912-213000");
    expect(md).toContain("Outcome: **stopped**. Step 2 failed after 3 attempts (1 landed, 1 failed, 1 skipped, 3 total)");
    expect(md).toContain("| Base | `main` at `8b9d32012345` |");
    expect(md).toContain("| Total cost | $1.75 |");
  });

  it("writes one row per step with status, attempts, reason, commit, and files", () => {
    expect(md).toContain("| 1 | Step 1: Add PUT | landed | 1 |  | `abc1234` | `app/api/log/route.js` +30 -2<br>`img.png` (binary) |");
    expect(md).toContain("| 2 | Step 2: Fix \\| component | failed | 3 | gate |  |  |");
    expect(md).toContain("| 3 | Step 3: Log | skipped | 0 |  |  |  |");
  });

  it("includes the gate tail for a failed step", () => {
    expect(md).toContain("## Step 2 failure: last 40 lines of the last gate log");
    expect(md).toContain("FAIL tests/unit/x.test.js");
  });

  it("gives review, take, and discard commands", () => {
    expect(md).toContain("git -C /Users/me/app log --oneline main..loop/20260912-213000");
    expect(md).toContain("git -C /Users/me/app diff main..loop/20260912-213000");
    expect(md).toContain("git -C /Users/me/app merge --ff-only loop/20260912-213000");
    expect(md).toContain("Only works if the target's checkout is on `main`");
    expect(md).toContain(
      "git -C /Users/me/app worktree remove /Users/me/.build-loop/worktrees/app/20260912-213000 && git -C /Users/me/app branch -D loop/20260912-213000"
    );
  });

  it("includes a setup log when install or the baseline failed", () => {
    const refused = renderReport({ ...state, setupLog: { title: "Baseline gate log", text: "lint exploded" } });
    expect(refused).toContain("## Baseline gate log (last 40 lines)");
    expect(refused).toContain("lint exploded");
  });

  it("marks a dry run and has no cost", () => {
    const dry = renderReport({ ...state, dryRun: true, outcome: "dry run", stopReason: null, steps: state.steps.map((s) => ({ ...s, status: "skipped", costUsd: null })) });
    expect(dry).toContain("sonnet (dry run, not called)");
    expect(dry).toContain("| Total cost | n/a |");
    expect(dry).toContain("(0 landed, 0 failed, 3 skipped, 3 total)");
    expect(dry).not.toContain("—");
  });
});

describe("totalCost, runId, runPaths", () => {
  it("sums known costs only", () => {
    expect(totalCost([{ costUsd: 1 }, { costUsd: null }, { costUsd: 0.5 }])).toBe(1.5);
    expect(totalCost([{ costUsd: null }])).toBeNull();
  });

  it("formats run ids as YYYYMMDD-HHMMSS", () => {
    expect(runId(new Date(2026, 8, 2, 7, 5, 9))).toBe("20260902-070509");
  });

  it("lays out worktree and run folders by target basename", () => {
    expect(runPaths("/Users/me/Sites/app", "20260912-213000", { BUILD_LOOP_HOME: "/state" })).toEqual({
      targetName: "app",
      branch: "loop/20260912-213000",
      worktree: "/state/worktrees/app/20260912-213000",
      runDir: "/state/runs/app/20260912-213000",
      worktreesDir: "/state/worktrees/app",
    });
  });
});
