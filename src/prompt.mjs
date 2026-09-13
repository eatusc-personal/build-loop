// Prompt assembly for one attempt of one step. Pure apart from loadPreamble.

import fs from "node:fs";

export const PREAMBLE_PATH = new URL("./preamble.md", import.meta.url);

// Read at run time so the preamble can be edited without a code change.
export function loadPreamble() {
  return fs.readFileSync(PREAMBLE_PATH, "utf8").trim();
}

export const FEEDBACK_LINES = 60;

export function tailLines(text, n) {
  const lines = String(text ?? "").replace(/\s+$/, "").split("\n");
  return lines.slice(-n).join("\n");
}

function feedback({ attempt, attempts, previous }) {
  const head = `Attempt ${attempt} of ${attempts}. Your previous attempt is still in the working tree.`;
  switch (previous.reason) {
    case "scope":
      return `${head} It changed files outside the allowed paths, so it failed before the gate ran. Revert or move these changes:\n\n${previous.paths.map((p) => `- ${p}`).join("\n")}`;
    case "unreviewable":
      return `${head} It left content that git cannot show as a text diff, so it failed before the gate ran. Use printable characters, or an escape sequence such as \\u0000 inside a string, in these files:\n\n${previous.paths.map((p) => `- ${p}`).join("\n")}`;
    case "no changes":
      return `${head} It changed no files, so it failed. The step needs a change in the working tree.`;
    case "timeout":
      return `${head} It ran past the time limit and was stopped, so it may be incomplete. Pick up where it left off and keep this attempt shorter.`;
    default:
      return `${head} The gate failed. Here are the last ${FEEDBACK_LINES} lines of its output:\n\n\`\`\`\n${tailLines(previous.logTail, FEEDBACK_LINES)}\n\`\`\``;
  }
}

export function assemblePrompt({ preamble, title = null, context, step, attempt = 1, attempts = 1, previous = null }) {
  const parts = [preamble.trim()];
  // Shared context from the top of the steps file, under the file's own title.
  if (context) parts.push(`# ${title ?? "Context for every step"}\n\n${context}`);
  parts.push(`## ${step.heading}\n\n${step.body}`);
  if (step.doneWhen) parts.push(`DONE WHEN: ${step.doneWhen}`);
  if (step.allowed) {
    parts.push(`You may only change these paths:\n\n${step.allowed.map((p) => `- ${p}`).join("\n")}`);
  }
  if (attempt > 1 && previous) parts.push(feedback({ attempt, attempts, previous }));
  return `${parts.join("\n\n")}\n`;
}
