import { describe, expect, it } from "vitest";
import { runId, runPaths } from "../../src/paths.mjs";
import { renderReport, shq, totalCost } from "../../src/report.mjs";

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
      turns: 12,
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
      turns: 40,
    },
    { index: 3, heading: "Step 3: Log", status: "skipped", attemptsUsed: 0, reason: null, commit: null, files: [], costUsd: null, turns: null },
  ],
};

describe("renderReport", () => {
  const md = renderReport(state);

  it("summarizes the run and its total cost", () => {
    expect(md).toContain("# build-loop report: loop/20260912-213000");
    expect(md).toContain("Outcome: **stopped**. Step 2 failed after 3 attempts (1 landed, 1 failed, 1 skipped, 3 total)");
    expect(md).toContain("| Base | `main` at `8b9d32012345` |");
    expect(md).toContain("| Total cost | $1.75 |");
    expect(md).toContain("| # | Step | Status | Attempts | Turns | Cost | Reason | Commit | Files changed |");
  });

  it("writes one row per step with status, attempts, reason, commit, and files", () => {
    expect(md).toContain("| 1 | Step 1: Add PUT | landed | 1 | 12 | $0.50 |  | `abc1234` | `app/api/log/route.js` +30 -2<br>`img.png` (binary) |");
    expect(md).toContain("| 2 | Step 2: Fix \\| component | failed | 3 | 40 | $1.25 | gate |  |  |");
    expect(md).toContain("| 3 | Step 3: Log | skipped | 0 | - | - |  |  |  |");
  });

  it("includes the gate tail for a failed step", () => {
    expect(md).toContain("## Step 2 failure: last 40 lines of the last gate log");
    expect(md).toContain("FAIL tests/unit/x.test.js");
  });

  it("gives review, take, and discard commands", () => {
    expect(md).toContain("git -C /Users/me/app log --oneline 8b9d3201234567890..loop/20260912-213000");
    expect(md).toContain("git -C /Users/me/app diff 8b9d3201234567890..loop/20260912-213000");
    expect(md).toContain("From the commit the run started on (`main` at `8b9d32012345`)");
    expect(md).toContain("git -C /Users/me/app merge --ff-only loop/20260912-213000");
    expect(md).toContain("Only works if the target's checkout is on `main`");
    expect(md).toContain(
      "git -C /Users/me/app worktree remove /Users/me/.build-loop/worktrees/app/20260912-213000 && git -C /Users/me/app branch -D loop/20260912-213000"
    );
  });

  it("says ff-only when the checkout can fast-forward, and plain merge when it has moved", () => {
    const ff = renderReport({ ...state, take: { checkout: "main", canFastForward: true } });
    expect(ff).toContain("the target's checkout (`main`) could fast-forward to this branch");
    expect(ff).toContain("git -C /Users/me/app merge --ff-only loop/20260912-213000");
    expect(ff).not.toContain("Only works if");

    const moved = renderReport({ ...state, take: { checkout: "main", canFastForward: false } });
    expect(moved).toContain("had commits this branch does not, so a fast-forward will not work");
    expect(moved).toContain("git -C /Users/me/app merge loop/20260912-213000\n");
    expect(moved).not.toContain("--ff-only");
  });

  it("notes that a loop-branch base is taken along with this run", () => {
    const stacked = renderReport({
      ...state,
      base: "loop/20260912-200000",
      take: { checkout: "main", canFastForward: true },
    });
    expect(stacked).toContain("| Base | `loop/20260912-200000` at");
    expect(stacked).toContain("This branch is built on `loop/20260912-200000`, so taking it also takes that run's commits.");
    expect(stacked).toContain("git -C /Users/me/app log --oneline main..loop/20260912-213000");
    expect(stacked).toContain("git -C /Users/me/app diff 8b9d3201234567890..loop/20260912-213000");
    expect(renderReport(state)).not.toContain("This branch is built on");
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
    expect(dry).not.toContain("\u2014");
  });
});

describe("shell quoting in handoff commands", () => {
  it("leaves plain paths alone and quotes anything a shell would reinterpret", () => {
    expect(shq("/Users/me/app")).toBe("/Users/me/app");
    expect(shq("main..loop/20260913-090000")).toBe("main..loop/20260913-090000");
    expect(shq("/Users/me/my app")).toBe("'/Users/me/my app'");
    expect(shq("/x/$(touch pwn)")).toBe("'/x/$(touch pwn)'");
    expect(shq("/x/`id`")).toBe("'/x/`id`'");
    expect(shq("it's")).toBe("'it'\\''s'");
  });

  it("quotes the target and worktree in every command", () => {
    const md = renderReport({
      ...state,
      target: "/Users/me/My Apps/$(touch pwn)",
      worktree: "/Users/me/.build-loop/worktrees/My Apps/1",
      take: { checkout: "main", canFastForward: false },
    });
    expect(md).toContain("git -C '/Users/me/My Apps/$(touch pwn)' diff 8b9d3201234567890..loop/20260912-213000");
    expect(md).toContain("git -C '/Users/me/My Apps/$(touch pwn)' merge loop/20260912-213000");
    expect(md).toContain("worktree remove '/Users/me/.build-loop/worktrees/My Apps/1' && git -C '/Users/me/My Apps/$(touch pwn)' branch -D loop/20260912-213000");
    expect(md).not.toMatch(/git -C \/Users\/me\/My Apps/);
  });
});

describe("totalCost, runId, runPaths", () => {
  it("sums known costs only", () => {
    expect(totalCost([{ costUsd: 1 }, { costUsd: null }, { costUsd: 0.5 }])).toBe(1.5);
    expect(totalCost([{ costUsd: null }])).toBeNull();
  });

  it("formats run ids as YYYYMMDD-HHMMSS plus a random suffix", () => {
    expect(runId(new Date(2026, 8, 2, 7, 5, 9))).toMatch(/^20260902-070509-[0-9a-f]{6}$/);
  });

  it("gives two runs started in the same second different ids", () => {
    const at = new Date(2026, 8, 2, 7, 5, 9);
    const ids = new Set(Array.from({ length: 50 }, () => runId(at)));
    expect(ids.size).toBe(50);
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
