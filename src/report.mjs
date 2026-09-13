// report.md rendering from a run-state object. Pure.
//
// State shape:
//   { target, base, baseCommit, branch, worktree, runDir, model, dryRun,
//     startedAt, endedAt, outcome, stopReason, setupLog: { title, text },
//     take: { checkout, canFastForward },
//     steps: [{ index, heading, status, attemptsUsed, reason, commit,
//               files: [{ path, added, removed }], gateTail, costUsd, turns }] }
// costUsd and turns are summed across a step's attempts, or null when unknown.
// status is one of: pending, running, landed, failed, skipped.

export const GATE_TAIL_LINES = 40;

// Quote a value for a POSIX shell so a pasted command works with spaces and
// never expands $(...) or backticks. Plain paths and refs are left as they are.
export function shq(value) {
  const s = String(value);
  return /^[A-Za-z0-9_\/.:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

function money(n, missing = "n/a") {
  return typeof n === "number" ? `$${n.toFixed(2)}` : missing;
}

function cell(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function filesCell(files) {
  if (!files || files.length === 0) return "";
  return files
    .map((f) => (f.added === null ? `\`${f.path}\` (binary)` : `\`${f.path}\` +${f.added} -${f.removed}`))
    .join("<br>");
}

export function totalCost(steps) {
  const costs = steps.map((s) => s.costUsd).filter((c) => typeof c === "number");
  return costs.length ? costs.reduce((a, b) => a + b, 0) : null;
}

export const isLoopBranch = (name) => /^loop\//.test(name ?? "");

function takeBlock(state) {
  const t = state.target;
  const lines = ["## Take it", ""];
  if (isLoopBranch(state.base)) {
    lines.push(`This branch is built on \`${state.base}\`, so taking it also takes that run's commits.`, "");
  }
  const { checkout, canFastForward } = state.take ?? {};
  if (checkout && isLoopBranch(state.base)) {
    lines.push("Everything taking it brings in:", "", "```", `git -C ${shq(t)} log --oneline ${shq(`${checkout}..${state.branch}`)}`, "```", "");
  }
  if (checkout && canFastForward === true) {
    lines.push(`When this report was written, the target's checkout (\`${checkout}\`) could fast-forward to this branch:`);
    lines.push("", "```", `git -C ${shq(t)} merge --ff-only ${shq(state.branch)}`, "```", "");
  } else if (checkout && canFastForward === false) {
    lines.push(
      `When this report was written, the target's checkout (\`${checkout}\`) had commits this branch does not, so a fast-forward will not work. Merge it:`
    );
    lines.push("", "```", `git -C ${shq(t)} merge ${shq(state.branch)}`, "```", "");
  } else {
    lines.push(`Only works if the target's checkout is on \`${state.base}\` and \`${state.base}\` has not moved past the branch point.`);
    lines.push("", "```", `git -C ${shq(t)} merge --ff-only ${shq(state.branch)}`, "```", "");
  }
  return lines;
}

export function renderReport(state) {
  const cost = totalCost(state.steps);
  const lines = [];
  const counts = (status) => state.steps.filter((s) => s.status === status).length;

  lines.push(`# build-loop report: ${state.branch}`, "");
  lines.push(
    `Outcome: **${state.outcome ?? "running"}**` +
      (state.stopReason ? `. ${state.stopReason}` : "") +
      ` (${counts("landed")} landed, ${counts("failed")} failed, ${counts("skipped")} skipped, ${state.steps.length} total)`,
    ""
  );

  lines.push(
    "| | |",
    "| --- | --- |",
    `| Machine | ${state.machine ? `${state.machine.name} (${state.machine.hostname})` : "not recorded"} |`,
    `| Target | \`${state.target}\`${state.repo?.origin ? ` (${state.repo.origin})` : ""} |`,
    `| Base | \`${state.base}\` at \`${(state.baseCommit ?? "").slice(0, 12)}\` |`,
    `| Branch | \`${state.branch}\` |`,
    `| Worktree | \`${state.worktree}\` |`,
    `| Run logs | \`${state.runDir}\` |`,
    `| Model | ${state.dryRun ? `${state.model} (dry run, not called)` : state.model} |`,
    ...(state.sandbox
      ? [`| Sandbox | ${state.sandbox.enabled ? "on: Claude and the gate ran under macOS Seatbelt (profiles in the run folder)" : "**off: Claude and the gate ran with full user permissions**"} |`]
      : []),
    ...(state.stepsFile ? [`| Steps file | \`${state.stepsFile.source}\` (copy saved as steps.md, sha256 \`${state.stepsFile.sha256.slice(0, 12)}\`) |`] : []),
    ...(state.runner?.commit ? [`| Runner | build-loop \`${state.runner.commit.slice(0, 7)}\`${state.runner.dirty ? " with uncommitted changes" : ""} |`] : []),
    `| Started | ${state.startedAt ?? ""} |`,
    `| Ended | ${state.endedAt ?? "still running"} |`,
    `| Total cost | ${money(cost)} |`,
    ""
  );

  lines.push("## Steps", "");
  lines.push(
    "| # | Step | Status | Attempts | Turns | Cost | Reason | Commit | Files changed |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  );
  for (const s of state.steps) {
    const turns = typeof s.turns === "number" ? s.turns : "-";
    lines.push(
      `| ${s.index} | ${cell(s.heading)} | ${s.status} | ${s.attemptsUsed ?? 0} | ${turns} | ${money(s.costUsd, "-")} | ${cell(s.reason)} | ` +
        `${s.commit ? `\`${s.commit.slice(0, 7)}\`` : ""} | ${filesCell(s.files)} |`
    );
  }
  lines.push("");

  if (state.setupLog) {
    lines.push(`## ${state.setupLog.title} (last ${GATE_TAIL_LINES} lines)`, "", "```", state.setupLog.text, "```", "");
  }

  for (const s of state.steps.filter((x) => x.status === "failed" && x.gateTail)) {
    lines.push(`## Step ${s.index} failure: last ${GATE_TAIL_LINES} lines of the last gate log`, "", "```", s.gateTail, "```", "");
  }

  const t = state.target;
  lines.push(
    "## Review it",
    "",
    "```",
    `git -C ${shq(t)} log --oneline ${shq(`${state.base}..${state.branch}`)}`,
    `git -C ${shq(t)} diff ${shq(`${state.base}..${state.branch}`)}`,
    "```",
    "",
    ...takeBlock(state),
    "## Discard it",
    "",
    "```",
    `git -C ${shq(t)} worktree remove ${shq(state.worktree)} && git -C ${shq(t)} branch -D ${shq(state.branch)}`,
    "```",
    ""
  );

  return lines.join("\n");
}
