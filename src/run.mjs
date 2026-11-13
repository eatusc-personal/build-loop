// The run: preflight, worktree, install, baseline, then each step's attempts.
// Decisions come from git and the gate exit code only. What Claude says is
// saved to the run folder and never read back to decide anything.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeVersion, parseClaudeOutput, runClaude } from "./claude.mjs";
import { killActive } from "./exec.mjs";
import { defaultInstall, hasCheckScript, runGate, runInstall } from "./gate.mjs";
import * as git from "./git.mjs";
import { outOfScope } from "./glob.mjs";
import { gateChanges } from "./gateguard.mjs";
import { childEnv } from "./env.mjs";
import { runId, runPaths, stateRoot } from "./paths.mjs";
import { collectProvenance } from "./provenance.mjs";
import { checkReviewable } from "./reviewable.mjs";
import { buildProfile, darwinUserDirs, sandboxAvailable } from "./sandbox.mjs";
import { execFileSync } from "node:child_process";
import { assemblePrompt, loadPreamble, tailLines } from "./prompt.mjs";
import { GATE_TAIL_LINES, renderReport } from "./report.mjs";
import { parseSteps } from "./steps.mjs";

export class Refusal extends Error {}

const clock = (d) => d.toTimeString().slice(0, 8);
const pad = (n) => String(n).padStart(2, "0");
// Local time for the report, for example 2026-09-12 21:39:47.
export const localStamp = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(d)}`;
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
  if (opts.sandbox !== false && !sandboxAvailable()) {
    throw new Refusal("the macOS sandbox (sandbox-exec) is not available here; pass --no-sandbox to run Claude and the gate with your full user permissions");
  }
  if (!fs.existsSync(opts.steps)) throw new Refusal(`steps file not found: ${opts.steps}`);
  const stepsText = fs.readFileSync(opts.steps, "utf8");
  const parsed = parseSteps(stepsText);
  if (parsed.steps.length === 0) throw new Refusal(`steps file has no steps (no "## " headings): ${opts.steps}`);
  const emptyAllowed = parsed.steps.find((s) => Array.isArray(s.allowed) && s.allowed.length === 0);
  if (emptyAllowed) {
    throw new Refusal(`step ${emptyAllowed.index} has an ALLOWED: line with no paths; list the paths it may change, or remove the line to allow any`);
  }
  if (git.isDirty(opts.target)) throw new Refusal(`target has uncommitted changes; commit or stash them first: ${opts.target}`);
  if (!git.branchExists(opts.target, opts.base)) throw new Refusal(`base branch does not exist: ${opts.base}`);
  if (!hasCheckScript(git.showFile(opts.target, opts.base, "package.json") ?? "")) {
    throw new Refusal(`package.json on ${opts.base} has no "check" script`);
  }
  const version = opts.claudeCmdGiven ? null : claudeVersion("claude");
  if (!opts.claudeCmdGiven && !version) throw new Refusal("`claude --version` failed; is the Claude CLI installed?");
  return { parsed, stepsText, claudeVersion: version };
}

export async function runLoop(opts, { out = (line) => process.stdout.write(`${line}\n`), env = process.env, now = () => new Date() } = {}) {
  const { parsed, stepsText, claudeVersion: claudeVer } = preflight(opts);
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
    ...collectProvenance({ opts, env, stepsText, claudeVersion: claudeVer }),
    runId: id,
    pid: process.pid,
    target: opts.target,
    base: opts.base,
    // Resolved once. The worktree is cut from this exact commit and the review
    // commands use it, so a base branch that moves later cannot change either.
    baseCommit: git.revParse(opts.target, `${opts.base}^{commit}`),
    // PROTECTED: globs from the steps file, checked with the gate scripts.
    protectedPaths: parsed.protected,
    branch: paths.branch,
    worktree: paths.worktree,
    runDir: paths.runDir,
    model: opts.model,
    dryRun: opts.dryRun,
    sandbox: { enabled: opts.sandbox !== false, profiles: [] },
    startedAt: localStamp(startedAt),
    startedAtUtc: startedAt.toISOString(),
    endedAt: null,
    endedAtUtc: null,
    outcome: "running",
    stopReason: null,
    setupLog: null,
    take: null,
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
      turns: null,
      attempts: [],
    })),
  };

  // The gate as the base commit defines it. An attempt that changes it fails,
  // whatever ALLOWED says, so the agent cannot weaken what authorizes its commit.
  const baseGate = {
    packageJson: git.showFile(opts.target, state.baseCommit, "package.json"),
    npmrc: git.showFile(opts.target, state.baseCommit, ".npmrc"),
  };
  const gateTouched = (changed) => gateChanges(paths.worktree, { base: baseGate, changed, protect: parsed.protected });

  // Whether the target's checked-out branch can fast-forward to this run's
  // branch right now. Recomputed on every write, since the checkout can move
  // while a run is going (for example a commit on main while a follow-up runs).
  const takeAdvice = () => {
    const checkout = git.currentBranch(opts.target);
    if (!checkout || !git.branchExists(opts.target, paths.branch)) return { checkout, canFastForward: null };
    return { checkout, canFastForward: git.isAncestor(opts.target, checkout, paths.branch) };
  };

  const writeReport = () => {
    state.take = takeAdvice();
    fs.writeFileSync(reportPath, renderReport(state));
    fs.writeFileSync(file("state.json"), `${JSON.stringify(state, null, 2)}\n`);
  };

  const finish = (outcome, stopReason, code) => {
    state.outcome = outcome;
    state.stopReason = stopReason;
    const ended = now();
    state.endedAt = localStamp(ended);
    state.endedAtUtc = ended.toISOString();
    for (const s of state.steps) if (s.status === "pending" || s.status === "running") s.status = "skipped";
    fs.rmSync(runTmp, { recursive: true, force: true });
    writeReport();
    out(reportPath);
    out(paths.branch);
    return code;
  };

  fs.mkdirSync(paths.runDir, { recursive: true });
  fs.mkdirSync(paths.worktreesDir, { recursive: true });
  // The exact steps text this run used, so later edits to the file cannot change the record.
  fs.writeFileSync(file("steps.md"), stepsText);
  // Write "running" with this pid before the worktree exists, so clean never
  // sees the worktree without a live run behind it.
  writeReport();

  const npmCache = path.join(stateRoot(env), "npm-cache");
  fs.mkdirSync(npmCache, { recursive: true });
  // A temp folder of this run's own. Children get it as TMPDIR, and the sandbox
  // allows it by path, so the runner's own TMPDIR never decides what is writable.
  const runTmp = path.join(stateRoot(env), "tmp", id);
  fs.mkdirSync(runTmp, { recursive: true });
  // Children get an allowlisted environment, never a copy of the runner's.
  const baseEnv = childEnv(env, { npm_config_cache: npmCache, TMPDIR: runTmp });
  const setupChanges = () => git.changedPaths(paths.worktree);

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
    git.worktreeAdd(opts.target, paths.branch, paths.worktree, state.baseCommit);
    event(`worktree created at ${paths.worktree} on ${paths.branch}`);

    // Sandbox profiles use real paths (/tmp is /private/tmp on macOS).
    const profiles = { claude: null, gate: null, install: null };
    if (state.sandbox.enabled) {
      const real = (p) => fs.realpathSync(p);
      const common = {
        home: real(os.homedir()),
        worktree: real(paths.worktree),
        target: real(opts.target),
        tmpDirs: [
          real(runTmp),
          ...darwinUserDirs({ getconf: (name) => execFileSync("getconf", [name], { encoding: "utf8" }), realpath: real }),
        ],
        npmCache: real(npmCache),
      };
      for (const kind of ["install", "claude", "gate"]) {
        profiles[kind] = file(`sandbox-${kind}.sb`);
        fs.writeFileSync(profiles[kind], buildProfile({ kind, ...common }));
      }
      state.sandbox.profiles = ["sandbox-install.sb", "sandbox-claude.sb", "sandbox-gate.sb"];
      event("sandbox profiles written");
    } else {
      event("WARNING: running without the sandbox; Claude and the gate have your full user permissions");
    }
    writeReport();

    const install = opts.install ?? defaultInstall(paths.worktree);
    event(`install started: ${install}`);
    const installed = await runInstall(paths.worktree, install, file("install.log"), {
      profileFile: profiles.install,
      env: baseEnv,
      timeoutMs: opts.installTimeoutMinutes * 60 * 1000,
      marker: `${id}-install`,
    });
    if (!installed.ok) {
      state.setupLog = { title: "Install log", text: tailLines(readText(file("install.log")), GATE_TAIL_LINES) };
      const why = installed.timedOut ? `timed out after ${opts.installTimeoutMinutes} min` : `exited ${installed.code}`;
      event(`install failed (${why})`);
      return finish("failed", `install failed: \`${install}\` ${why}`, 1);
    }
    event("install done");

    // Setup must not change the tree, or a step could commit its leftovers as work.
    const changedByInstall = setupChanges();
    if (changedByInstall.length) {
      event(`install changed files: ${changedByInstall.join(", ")}`);
      return finish("refused", `install changed files in the worktree (${changedByInstall.join(", ")}); commit them to ${opts.base} or pass a different --install`, 1);
    }

    // Same rule as before every step's gate: ignored files outside node_modules
    // (anything install produced besides dependencies) are removed first.
    git.cleanIgnored(paths.worktree);
    event("baseline gate started");
    const baseline = await runGate(paths.worktree, file("baseline.gate.log"), {
      profileFile: profiles.gate,
      env: baseEnv,
      timeoutMs: opts.gateTimeoutMinutes * 60 * 1000,
      marker: `${id}-baseline`,
    });
    if (!baseline.ok) {
      state.setupLog = { title: "Baseline gate log", text: tailLines(readText(file("baseline.gate.log")), GATE_TAIL_LINES) };
      const why = baseline.timedOut ? `baseline gate timed out after ${opts.gateTimeoutMinutes} min` : "baseline red";
      event(why);
      return finish("refused", why, 1);
    }
    const changedByBaseline = setupChanges();
    if (changedByBaseline.length) {
      event(`baseline gate changed files: ${changedByBaseline.join(", ")}`);
      return finish("refused", `the baseline gate changed files in the worktree (${changedByBaseline.join(", ")}); the gate must not write tracked or unignored files`, 1);
    }
    event("baseline green");

    const preamble = loadPreamble();

    if (opts.dryRun) {
      for (const step of parsed.steps) {
        const prompt = assemblePrompt({ preamble, title: parsed.title, context: parsed.context, step, attempt: 1, attempts: opts.attempts, protect: parsed.protected });
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
        const prompt = assemblePrompt({ preamble, title: parsed.title, context: parsed.context, step, attempt, attempts: opts.attempts, previous, protect: parsed.protected });
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
          profileFile: profiles.claude,
          env: baseEnv,
          marker: `${id}-${stem}-claude`,
        });
        const claude = parseClaudeOutput(readText(file(`${stem}.json`)));
        if (claude.total_cost_usd !== null) s.costUsd = (s.costUsd ?? 0) + claude.total_cost_usd;
        if (claude.num_turns !== null) s.turns = (s.turns ?? 0) + claude.num_turns;
        const record = { attempt, exitCode: proc.code, timedOut: proc.timedOut, claude, reason: null, paths: [], launchError: proc.launchError ?? null };
        s.attempts.push(record);

        // A command that cannot start will not start on the next attempt either.
        if (proc.launchError) {
          record.reason = "launch error";
          Object.assign(s, { status: "failed", reason: `launch error: ${proc.launchError}` });
          event(`step ${step.index} attempt ${attempt}: Claude could not be started: ${proc.launchError}`);
          git.discardChanges(paths.worktree);
          return finish("failed", `Claude could not be started: ${proc.launchError}`, 1);
        }

        let failure = null;
        let unreviewable = [];
        let tampered = [];
        if (proc.timedOut) {
          failure = { reason: "timeout" };
          event(`step ${step.index} attempt ${attempt} timed out after ${opts.timeoutMinutes} min`);
        } else {
          const changed = git.changedPaths(paths.worktree);
          const outside = outOfScope(changed, step.allowed);
          if (changed.length === 0) {
            failure = { reason: "no changes" };
            event(`step ${step.index} attempt ${attempt} changed nothing`);
          } else if ((tampered = gateTouched(changed)).length) {
            failure = { reason: "gate changed", paths: tampered };
            event(`step ${step.index} attempt ${attempt} changed the gate: ${tampered.join(", ")}`);
          } else if (outside.length) {
            failure = { reason: "scope", paths: outside };
            event(`step ${step.index} attempt ${attempt} out of scope: ${outside.join(", ")}`);
          } else if ((unreviewable = checkReviewable(paths.worktree, changed)).length) {
            failure = { reason: "unreviewable", paths: unreviewable };
            event(`step ${step.index} attempt ${attempt} unreviewable: ${unreviewable.join("; ")}`);
          } else {
            // Ignored files an attempt left behind (build output, test caches) could
            // change what the gate does, and the scope check cannot see them.
            git.cleanIgnored(paths.worktree);
            event("gate started");
            const gate = await runGate(paths.worktree, file(`${stem}.gate.log`), {
              profileFile: profiles.gate,
              env: baseEnv,
              timeoutMs: opts.gateTimeoutMinutes * 60 * 1000,
              marker: `${id}-${stem}-gate`,
            });
            // The gate runs code the attempt wrote, and that code can change files
            // too. Check scope and readability again on what will actually be committed.
            const afterGate = gate.ok ? git.changedPaths(paths.worktree) : [];
            const tamperedAfter = gate.ok ? gateTouched(afterGate) : [];
            const outsideAfter = gate.ok && !tamperedAfter.length ? outOfScope(afterGate, step.allowed) : [];
            const unreviewableAfter = gate.ok && !tamperedAfter.length && !outsideAfter.length ? checkReviewable(paths.worktree, afterGate) : [];
            if (gate.ok && afterGate.length === 0) {
              // The gate undid the attempt's last change. Nothing is left to
              // commit, which is the same outcome as an attempt that changed nothing.
              failure = { reason: "no changes" };
              event(`step ${step.index} attempt ${attempt} has no changes left after the gate`);
            } else if (gate.ok && tamperedAfter.length) {
              failure = { reason: "gate changed", paths: tamperedAfter };
              event(`step ${step.index} attempt ${attempt} changed the gate during the gate run: ${tamperedAfter.join(", ")}`);
            } else if (gate.ok && outsideAfter.length) {
              failure = { reason: "scope", paths: outsideAfter };
              event(`step ${step.index} attempt ${attempt} out of scope after the gate: ${outsideAfter.join(", ")}`);
            } else if (gate.ok && unreviewableAfter.length) {
              failure = { reason: "unreviewable", paths: unreviewableAfter };
              event(`step ${step.index} attempt ${attempt} unreviewable after the gate: ${unreviewableAfter.join("; ")}`);
            } else if (gate.ok) {
              const committed = git.commitAll(paths.worktree, `loop: ${step.heading}`, afterGate);
              if (committed.mismatch) {
                failure = { reason: "scope", paths: committed.mismatch };
                event(`step ${step.index} attempt ${attempt} staged files differ from the checked files: ${committed.mismatch.join(", ")}`);
              } else {
                Object.assign(s, { status: "landed", reason: null, commit: committed.hash, files: committed.files });
                event(`landed ${committed.hash.slice(0, 7)}`);
              }
            } else {
              const log = readText(file(`${stem}.gate.log`));
              s.gateTail = tailLines(log, GATE_TAIL_LINES);
              failure = { reason: gate.timedOut ? "gate timeout" : "gate", logTail: log };
              event(gate.timedOut ? `gate timed out after ${opts.gateTimeoutMinutes} min` : "gate red");
            }
          }
        }

        if (failure) {
          record.reason = failure.reason;
          record.paths = failure.paths ?? [];
          s.reason = failure.paths ? `${failure.reason}: ${failure.paths.join(failure.reason === "unreviewable" ? "; " : ", ")}` : failure.reason;
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
