// `build-loop runs`: rebuild ~/.build-loop/runs.jsonl from the run folders and
// print a summary. The run folders stay the source of truth; the index can be
// deleted and rebuilt at any time. summarizeRun, decide, and renderRunsTable
// are pure.

import fs from "node:fs";
import path from "node:path";
import * as git from "./git.mjs";
import { stateRoot } from "./paths.mjs";
import { currentMachine } from "./provenance.mjs";

// The last commit a run landed, which is what "taking" the run means.
export function lastLandedCommit(state) {
  const landed = (state.steps ?? []).filter((s) => s.status === "landed" && s.commit);
  return landed.length ? landed[landed.length - 1].commit : null;
}

export function summarizeRun(state, { runDir }) {
  const steps = state.steps ?? [];
  const sum = (key) => {
    const vals = steps.map((s) => s[key]).filter((v) => typeof v === "number");
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const runId = state.runId ?? path.basename(runDir);
  const targetName = path.basename(state.target ?? path.dirname(runDir));
  const machine = state.machine?.name ?? null;
  const started = state.startedAtUtc ? Date.parse(state.startedAtUtc) : null;
  const ended = state.endedAtUtc ? Date.parse(state.endedAtUtc) : null;

  return {
    key: `${machine ?? "unrecorded"}/${targetName}/${runId}`,
    schemaVersion: state.schemaVersion ?? 1,
    runId,
    machine,
    hostname: state.machine?.hostname ?? null,
    targetName,
    target: state.target ?? null,
    repo: state.repo?.origin ?? null,
    base: state.base ?? null,
    baseCommit: state.baseCommit ?? null,
    branch: state.branch ?? null,
    model: state.model ?? null,
    dryRun: Boolean(state.dryRun),
    stepsFile: state.stepsFile?.source ?? null,
    stepsSha256: state.stepsFile?.sha256 ?? null,
    runnerCommit: state.runner?.commit ?? null,
    startedAt: state.startedAtUtc ?? state.startedAt ?? null,
    endedAt: state.endedAtUtc ?? state.endedAt ?? null,
    durationSec: started !== null && ended !== null ? Math.round((ended - started) / 1000) : null,
    outcome: state.outcome ?? null,
    stopReason: state.stopReason ?? null,
    stepsTotal: steps.length,
    stepsLanded: steps.filter((s) => s.status === "landed").length,
    stepsFailed: steps.filter((s) => s.status === "failed").length,
    totalCostUsd: sum("costUsd"),
    turns: sum("turns"),
    lastCommit: lastLandedCommit(state),
    steps: steps.map((s) => ({
      index: s.index,
      heading: s.heading,
      status: s.status,
      attempts: s.attemptsUsed ?? 0,
      turns: s.turns ?? null,
      costUsd: s.costUsd ?? null,
      reason: s.reason ?? null,
      commit: s.commit ?? null,
      filesChanged: (s.files ?? []).length,
    })),
    runDir,
  };
}

// facts: { thisMachine, targetExists, commitExists, merged, branchExists }
export function decide(row, facts, into) {
  if (row.outcome === "running") return { decision: "unfinished", detail: "still running, or stopped without writing an outcome" };
  if (!row.lastCommit) return { decision: "nothing to take", detail: "no step landed" };
  if (row.machine && row.machine !== facts.thisMachine) {
    return { decision: "unknown", detail: `the branch lives on ${row.machine}; run build-loop runs there` };
  }
  const prefix = row.machine ? "" : "machine not recorded; checked here: ";
  if (!facts.targetExists) return { decision: "unknown", detail: `${prefix}target not found on this machine` };
  if (!facts.commitExists) return { decision: "discarded", detail: `${prefix}its commits are no longer in the repo` };
  if (facts.merged) return { decision: "taken", detail: `${prefix}in ${into}` };
  if (facts.branchExists) return { decision: "pending", detail: `${prefix}branch not merged into ${into}` };
  return { decision: "discarded", detail: `${prefix}branch deleted without merging` };
}

function gitFacts(row, into) {
  const targetExists = Boolean(row.target) && fs.existsSync(row.target) && git.isRepo(row.target);
  if (!targetExists || !row.lastCommit) return { targetExists, commitExists: false, merged: false, branchExists: false };
  const commitExists = git.commitExists(row.target, row.lastCommit);
  return {
    targetExists,
    commitExists,
    merged: commitExists && git.branchExists(row.target, into) && git.isAncestor(row.target, row.lastCommit, into),
    branchExists: Boolean(row.branch) && git.branchExists(row.target, row.branch),
  };
}

export function readRuns(root) {
  const runsDir = path.join(root, "runs");
  if (!fs.existsSync(runsDir)) return [];
  const rows = [];
  for (const target of fs.readdirSync(runsDir).sort()) {
    const targetDir = path.join(runsDir, target);
    if (!fs.statSync(targetDir).isDirectory()) continue;
    for (const id of fs.readdirSync(targetDir).sort()) {
      const runDir = path.join(targetDir, id);
      const stateFile = path.join(runDir, "state.json");
      if (!fs.existsSync(stateFile)) continue;
      try {
        rows.push(summarizeRun(JSON.parse(fs.readFileSync(stateFile, "utf8")), { runDir }));
      } catch {
        rows.push({ key: `unreadable/${target}/${id}`, runId: id, targetName: target, outcome: "unreadable state.json", unreadable: true, runDir, steps: [] });
      }
    }
  }
  // Plain code-unit order: a timestamp sorts before the same timestamp with a
  // suffix, so old and new run ids interleave in start order.
  return rows.sort((a, b) => {
    const x = String(a.runId);
    const y = String(b.runId);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

const cost = (n) => (typeof n === "number" ? `$${n.toFixed(2)}` : "-");

export function renderRunsTable(rows) {
  const header = ["run", "machine", "target", "outcome", "steps", "cost", "decision"];
  const body = rows.map((r) => [
    r.runId,
    r.machine ?? "unrecorded",
    r.targetName,
    r.dryRun ? "dry run" : (r.outcome ?? ""),
    `${r.stepsLanded ?? 0}/${r.stepsTotal ?? 0}`,
    cost(r.totalCostUsd),
    r.decision ?? "",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => String(row[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), ...body.map(line)].join("\n");
}

export function buildIndex({ into = "main", env = process.env, now = () => new Date() } = {}) {
  const root = stateRoot(env);
  const thisMachine = currentMachine(env).name;
  const indexedAt = now().toISOString();
  const rows = readRuns(root).map((row) => {
    const { decision, detail } = row.unreadable
      ? { decision: "unknown", detail: "state.json could not be read" }
      : decide(row, { thisMachine, ...gitFacts(row, into) }, into);
    return { ...row, decision, decisionDetail: detail, decisionInto: into, decidedOn: thisMachine, indexedAt };
  });

  fs.mkdirSync(root, { recursive: true });
  const indexFile = path.join(root, "runs.jsonl");
  // A unique temp name per process, so two rebuilds at once cannot write into
  // or rename each other's file.
  const tmp = `${indexFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  fs.renameSync(tmp, indexFile);
  return { rows, indexFile, thisMachine };
}

export function runsCommand({ into }, { out = (line) => process.stdout.write(`${line}\n`), env = process.env } = {}) {
  const { rows, indexFile, thisMachine } = buildIndex({ into, env });
  if (rows.length === 0) out("no runs yet");
  else out(renderRunsTable(rows));
  out("");
  out(`${rows.length} run(s) indexed on ${thisMachine}; decisions checked against ${into}`);
  out(indexFile);
  return rows;
}
