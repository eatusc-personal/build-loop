// The run: preflight, worktree, install, baseline, then each step's attempts.
// Decisions come from git and the gate exit code only. What Claude says is
// saved to the run folder and never read back to decide anything.

import fs from "node:fs";
import path from "node:path";
import { claudeAvailable, parseClaudeOutput, runClaude } from "./claude.mjs";
import { killActive } from "./exec.mjs";
import { defaultInstall, hasCheckScript, runGate, runInstall } from "./gate.mjs";
import * as git from "./git.mjs";
import { outOfScope } from "./glob.mjs";
import { runId, runPaths } from "./paths.mjs";
import { assemblePrompt, loadPreamble, tailLines } from "./prompt.mjs";
import { GATE_TAIL_LINES, renderReport } from "./report.mjs";
import { parseSteps } from "./steps.mjs";

export class Refusal extends Error {}

const clock = (d) => d.toTimeString().slice(0, 8);
const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

// Every refusal is checked before anything is created on disk.
export function preflight(opts) {
  if (!fs.existsSync(opts.target) || !git.isRepo(opts.target)) throw new Refusal(`target is not a git repository: ${opts.target}`);
  if (!fs.existsSync(opts.steps)) throw new Refusal(`steps file not found: ${opts.steps}`);
  const parsed = parseSteps(fs.readFileSync(opts.steps, "utf8"));
  if (parsed.steps.length === 0) throw new Refusal(`steps file has no steps (no "## " headings): ${opts.steps}`);
  if (git.isDirty(opts.target)) throw new Refusal(`target has uncommitted changes; commit or stash them first: ${opts.target}`);
  if (!git.branchExists(opts.target, opts.base)) throw new Refusal(`base branch does not exist: ${opts.base}`);
  if (!hasCheckScript(git.showFile(opts.target, opts.base, "package.json") ?? "")) {
    throw new Refusal(`package.json on ${opts.base} has no "check" script`);
  }
  if (!opts.claudeCmdGiven && !claudeAvailable("claude")) throw new Refusal("`claude --version` failed; is the Claude CLI installed?");
  return parsed;
}

export async function runLoop(opts, { out = (line) => process.stdout.write(`${line}\n`), env = process.env, now = () => new Date() } = {}) {
  const parsed = preflight(opts);
  const startedAt = now();
  const id = runId(startedAt);
  const paths = runPaths(opts.target, id, env);
  if (fs.existsSync(paths.worktree) || git.branchExists(opts.target, paths.branch)) {
    throw new Refusal(`run ${id} already exists; wait a second and retry`);
  }

  const event = (msg) => out(`[${clock(now())}] ${msg}`);
  const file = (name) => path.join(paths.runDir, name);
  const reportPath = file("report.md");

  const state = {
    target: opts.target,
    base: opts.base,
    baseCommit: git.revParse(opts.target, opts.base),
    branch: paths.branch,
    worktree: paths.worktree,
    runDir: paths.runDir,
    model: opts.model,
    dryRun: opts.dryRun,
    startedAt: startedAt.toISOString(),
    endedAt: null,
    outcome: "running",
    stopReason: null,
    setupLog: null,
    steps: parsed.steps.map((s) => ({
      index: s.index,
      heading: s.heading,
      status: "pending",
      attemptsUsed: 0,
      reason: null,
      commit: null,
      files: [],
      gateTail: null,
      costUsd: null,
      attempts: [],
    })),
  };

  const writeReport = () => {
    fs.writeFileSync(reportPath, renderReport(state));
    fs.writeFileSync(file("state.json"), `${JSON.stringify(state, null, 2)}\n`);
  };

  const finish = (outcome, stopReason, code) => {
    state.outcome = outcome;
    state.stopReason = stopReason;
    state.endedAt = now().toISOString();
    for (const s of state.steps) if (s.status === "pending" || s.status === "running") s.status = "skipped";
    writeReport();
    out(reportPath);
    out(paths.branch);
    return code;
  };

  fs.mkdirSync(paths.runDir, { recursive: true });
  fs.mkdirSync(paths.worktreesDir, { recursive: true });

  const onSignal = (signal) => {
    killActive();
    try {
      finish("interrupted", `received ${signal}`, 130);
    } finally {
      process.exit(130);
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    git.worktreeAdd(opts.target, paths.branch, paths.worktree, opts.base);
    event(`worktree created at ${paths.worktree} on ${paths.branch}`);
    writeReport();

    const install = opts.install ?? defaultInstall(paths.worktree);
    event(`install started: ${install}`);
    const installed = await runInstall(paths.worktree, install, file("install.log"));
    if (!installed.ok) {
      state.setupLog = { title: "Install log", text: tailLines(readText(file("install.log")), GATE_TAIL_LINES) };
      event(`install failed (exit ${installed.code})`);
      return finish("failed", `install failed: \`${install}\` exited ${installed.code}`, 1);
    }
    event("install done");

    event("baseline gate started");
    const baseline = await runGate(paths.worktree, file("baseline.gate.log"));
    if (!baseline.ok) {
      state.setupLog = { title: "Baseline gate log", text: tailLines(readText(file("baseline.gate.log")), GATE_TAIL_LINES) };
      event("baseline red");
      return finish("refused", "baseline red", 1);
    }
    event("baseline green");

    const preamble = loadPreamble();

    if (opts.dryRun) {
      for (const step of parsed.steps) {
        const prompt = assemblePrompt({ preamble, context: parsed.context, step, attempt: 1, attempts: opts.attempts });
        fs.writeFileSync(file(`step-${step.index}-attempt-1.prompt.md`), prompt);
        out(`===== step ${step.index} prompt (dry run) =====`);
        out(prompt);
      }
      return finish("dry run", "Claude was not called", 0);
    }

    let failures = 0;
    for (const step of parsed.steps) {
      const s = state.steps[step.index - 1];
      s.status = "running";
      let previous = null;

      for (let attempt = 1; attempt <= opts.attempts; attempt++) {
        s.attemptsUsed = attempt;
        const stem = `step-${step.index}-attempt-${attempt}`;
        const prompt = assemblePrompt({ preamble, context: parsed.context, step, attempt, attempts: opts.attempts, previous });
        fs.writeFileSync(file(`${stem}.prompt.md`), prompt);
        event(`step ${step.index} attempt ${attempt} started`);

        const proc = await runClaude({
          cmd: opts.claudeCmd ?? "claude",
          prompt,
          model: opts.model,
          maxTurns: opts.maxTurns,
          cwd: paths.worktree,
          timeoutMs: opts.timeoutMinutes * 60 * 1000,
          stdoutFile: file(`${stem}.json`),
          stderrFile: file(`${stem}.stderr`),
        });
        const claude = parseClaudeOutput(readText(file(`${stem}.json`)));
        if (claude.total_cost_usd !== null) s.costUsd = (s.costUsd ?? 0) + claude.total_cost_usd;
        const record = { attempt, exitCode: proc.code, timedOut: proc.timedOut, claude, reason: null, paths: [] };
        s.attempts.push(record);

        let failure = null;
        if (proc.timedOut) {
          failure = { reason: "timeout" };
          event(`step ${step.index} attempt ${attempt} timed out after ${opts.timeoutMinutes} min`);
        } else {
          const changed = git.changedPaths(paths.worktree);
          const outside = outOfScope(changed, step.allowed);
          if (changed.length === 0) {
            failure = { reason: "no changes" };
            event(`step ${step.index} attempt ${attempt} changed nothing`);
          } else if (outside.length) {
            failure = { reason: "scope", paths: outside };
            event(`step ${step.index} attempt ${attempt} out of scope: ${outside.join(", ")}`);
          } else {
            event("gate started");
            const gate = await runGate(paths.worktree, file(`${stem}.gate.log`));
            if (gate.ok) {
              const { hash, files } = git.commitAll(paths.worktree, `loop: ${step.heading}`);
              Object.assign(s, { status: "landed", reason: null, commit: hash, files });
              event(`landed ${hash.slice(0, 7)}`);
            } else {
              const log = readText(file(`${stem}.gate.log`));
              s.gateTail = tailLines(log, GATE_TAIL_LINES);
              failure = { reason: "gate", logTail: log };
              event("gate red");
            }
          }
        }

        if (failure) {
          record.reason = failure.reason;
          record.paths = failure.paths ?? [];
          s.reason = failure.paths ? `scope: ${failure.paths.join(", ")}` : failure.reason;
          previous = failure;
        }
        writeReport();
        if (s.status === "landed") break;
      }

      if (s.status !== "landed") {
        s.status = "failed";
        failures++;
        git.discardChanges(paths.worktree);
        event(`step ${step.index} failed after ${opts.attempts} attempts (${s.reason}); tree reset to last green commit`);
        writeReport();
        if (!opts.continueOnFail) {
          return finish("stopped", `Step ${step.index} failed after ${opts.attempts} attempts (${s.reason})`, 1);
        }
      }
    }

    return failures
      ? finish("finished with failures", `${failures} step(s) failed`, 1)
      : finish("all steps landed", null, 0);
  } catch (e) {
    event(`error: ${e.message}`);
    return finish("error", e.message, 1);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
