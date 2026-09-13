import { describe, expect, it } from "vitest";
import { parseCli } from "../../src/args.mjs";
import { decide, lastLandedCommit, renderRunsTable, summarizeRun } from "../../src/runs.mjs";

const state = {
  schemaVersion: 2,
  runId: "20260913-090000",
  machine: { name: "studio", source: "hostname", hostname: "mac-studio.local" },
  repo: { origin: "https://github.com/me/app.git" },
  target: "/Users/me/code/app",
  base: "main",
  baseCommit: "b".repeat(40),
  branch: "loop/20260913-090000",
  model: "sonnet",
  dryRun: false,
  stepsFile: { source: "/Users/me/code/app/docs/steps.md", snapshot: "steps.md", sha256: "f".repeat(64) },
  runner: { commit: "c".repeat(40), dirty: false },
  startedAtUtc: "2026-09-13T16:00:00.000Z",
  endedAtUtc: "2026-09-13T16:04:30.000Z",
  outcome: "stopped",
  stopReason: "Step 2 failed after 3 attempts (gate)",
  steps: [
    { index: 1, heading: "Step 1", status: "landed", attemptsUsed: 1, turns: 8, costUsd: 0.25, commit: "1".repeat(40), files: [{}, {}] },
    { index: 2, heading: "Step 2", status: "failed", attemptsUsed: 3, turns: 30, costUsd: 1.1, reason: "gate", commit: null, files: [] },
    { index: 3, heading: "Step 3", status: "skipped", attemptsUsed: 0, turns: null, costUsd: null, commit: null, files: [] },
  ],
};

describe("summarizeRun", () => {
  const row = summarizeRun(state, { runDir: "/Users/me/.build-loop/runs/app/20260913-090000" });

  it("keys a run by machine, target, and run id", () => {
    expect(row.key).toBe("studio/app/20260913-090000");
    expect(row).toMatchObject({ machine: "studio", hostname: "mac-studio.local", targetName: "app", repo: "https://github.com/me/app.git" });
  });

  it("totals steps, cost, turns, and duration", () => {
    expect(row).toMatchObject({ stepsTotal: 3, stepsLanded: 1, stepsFailed: 1, turns: 38, durationSec: 270, lastCommit: "1".repeat(40) });
    expect(row.totalCostUsd).toBeCloseTo(1.35);
    expect(row.steps[0]).toEqual({ index: 1, heading: "Step 1", status: "landed", attempts: 1, turns: 8, costUsd: 0.25, reason: null, commit: "1".repeat(40), filesChanged: 2 });
  });

  it("reads a run recorded before provenance existed", () => {
    const legacy = summarizeRun(
      { target: "/repo/app", base: "main", outcome: "dry run", dryRun: true, startedAt: "2026-09-12 21:39:47", steps: [{ status: "skipped" }] },
      { runDir: "/state/runs/app/20260912-213947" }
    );
    expect(legacy).toMatchObject({ key: "unrecorded/app/20260912-213947", schemaVersion: 1, machine: null, runId: "20260912-213947", durationSec: null, totalCostUsd: null, lastCommit: null });
  });
});

describe("lastLandedCommit", () => {
  it("takes the last landed step's commit", () => {
    expect(lastLandedCommit({ steps: [{ status: "landed", commit: "a" }, { status: "landed", commit: "b" }, { status: "failed" }] })).toBe("b");
    expect(lastLandedCommit({ steps: [{ status: "failed" }] })).toBeNull();
  });
});

describe("decide", () => {
  const row = { machine: "studio", outcome: "all steps landed", lastCommit: "abc" };
  const facts = { thisMachine: "studio", targetExists: true, commitExists: true, merged: false, branchExists: true };

  it("is taken when the last landed commit is in the target branch", () => {
    expect(decide(row, { ...facts, merged: true, branchExists: false }, "main")).toEqual({ decision: "taken", detail: "in main" });
  });

  it("is pending while the branch exists and is not merged", () => {
    expect(decide(row, facts, "main")).toEqual({ decision: "pending", detail: "branch not merged into main" });
  });

  it("is discarded when the branch is gone without merging, or its commits are gone", () => {
    expect(decide(row, { ...facts, branchExists: false }, "main").decision).toBe("discarded");
    expect(decide(row, { ...facts, commitExists: false, branchExists: false }, "main")).toEqual({
      decision: "discarded",
      detail: "its commits are no longer in the repo",
    });
  });

  it("has nothing to take when no step landed", () => {
    expect(decide({ ...row, lastCommit: null }, facts, "main")).toEqual({ decision: "nothing to take", detail: "no step landed" });
  });

  it("is unknown for a run from another machine or a target that is not here", () => {
    expect(decide(row, { ...facts, thisMachine: "laptop" }, "main")).toEqual({
      decision: "unknown",
      detail: "the branch lives on studio; run build-loop runs there",
    });
    expect(decide(row, { ...facts, targetExists: false }, "main").decision).toBe("unknown");
  });

  it("checks an unrecorded machine here, and says so", () => {
    expect(decide({ ...row, machine: null }, { ...facts, thisMachine: "laptop", merged: true }, "main")).toEqual({
      decision: "taken",
      detail: "machine not recorded; checked here: in main",
    });
  });

  it("flags a run that never wrote an outcome", () => {
    expect(decide({ ...row, outcome: "running" }, facts, "main").decision).toBe("unfinished");
  });
});

describe("renderRunsTable and the runs command", () => {
  it("lines up one row per run", () => {
    const table = renderRunsTable([
      { runId: "20260913-090000", machine: "studio", targetName: "app", outcome: "stopped", stepsLanded: 1, stepsTotal: 3, totalCostUsd: 1.35, decision: "pending" },
      { runId: "20260912-213947", machine: null, targetName: "learning-app", dryRun: true, outcome: "dry run", stepsLanded: 0, stepsTotal: 3, totalCostUsd: null, decision: "nothing to take" },
    ]);
    const lines = table.split("\n");
    expect(lines[0]).toMatch(/^run\s+machine\s+target\s+outcome\s+steps\s+cost\s+decision$/);
    expect(lines[1]).toMatch(/^20260913-090000\s+studio\s+app\s+stopped\s+1\/3\s+\$1\.35\s+pending$/);
    expect(lines[2]).toMatch(/^20260912-213947\s+unrecorded\s+learning-app\s+dry run\s+0\/3\s+-\s+nothing to take$/);
  });

  it("parses runs with an optional --into", () => {
    expect(parseCli(["runs"])).toEqual({ command: "runs", into: "main" });
    expect(parseCli(["runs", "--into", "develop"])).toEqual({ command: "runs", into: "develop" });
  });
});
