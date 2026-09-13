// report.md rendering from a run-state object. Pure.
//
// State shape:
//   { target, base, baseCommit, branch, worktree, runDir, model, dryRun,
//     startedAt, endedAt, outcome, stopReason, setupLog: { title, text },
//     steps: [{ index, heading, status, attemptsUsed, reason, commit,
//               files: [{ path, added, removed }], gateTail, costUsd }] }
// status is one of: pending, running, landed, failed, skipped.

export const GATE_TAIL_LINES = 40;

function money(n) {
  return typeof n === "number" ? `$${n.toFixed(2)}` : "n/a";
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
    `| Target | \`${state.target}\` |`,
    `| Base | \`${state.base}\` at \`${(state.baseCommit ?? "").slice(0, 12)}\` |`,
    `| Branch | \`${state.branch}\` |`,
    `| Worktree | \`${state.worktree}\` |`,
    `| Run logs | \`${state.runDir}\` |`,
    `| Model | ${state.dryRun ? `${state.model} (dry run, not called)` : state.model} |`,
    `| Started | ${state.startedAt ?? ""} |`,
    `| Ended | ${state.endedAt ?? "still running"} |`,
    `| Total cost | ${money(cost)} |`,
    ""
  );

  lines.push("## Steps", "");
  lines.push("| # | Step | Status | Attempts | Reason | Commit | Files changed |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const s of state.steps) {
    lines.push(
      `| ${s.index} | ${cell(s.heading)} | ${s.status} | ${s.attemptsUsed ?? 0} | ${cell(s.reason)} | ` +
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
    `git -C ${t} log --oneline ${state.base}..${state.branch}`,
    `git -C ${t} diff ${state.base}..${state.branch}`,
    "```",
    "",
    "## Take it",
    "",
    `Only works if the target's checkout is on \`${state.base}\` and \`${state.base}\` has not moved past the branch point.`,
    "",
    "```",
    `git -C ${t} merge --ff-only ${state.branch}`,
    "```",
    "",
    "## Discard it",
    "",
    "```",
    `git -C ${t} worktree remove ${state.worktree} && git -C ${t} branch -D ${state.branch}`,
    "```",
    ""
  );

  return lines.join("\n");
}
