// The Claude CLI invocation. buildClaudeArgs and parseClaudeOutput are pure.

import { runToFiles, run } from "./exec.mjs";
import { wrap } from "./sandbox.mjs";

export const ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "MultiEdit",
  "Bash(npm run check)",
  "Bash(npm test*)",
  "Bash(npx vitest*)",
  "Bash(npx eslint*)",
  "Bash(git diff*)",
  "Bash(git status*)",
  "Bash(git log*)",
  "Bash(ls*)",
  "Bash(cat*)",
].join(",");

// No --dangerously-skip-permissions. dontAsk is passed explicitly so a user's
// default permission mode (for example bypassPermissions) cannot widen the
// allow list: anything not listed is denied without prompting. The target's
// own .claude/settings.json deny list still applies on top.
export function buildClaudeArgs({ prompt, model, maxTurns }) {
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    model,
    "--max-turns",
    String(maxTurns),
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    ALLOWED_TOOLS,
  ];
}

// The CLI's JSON is not our schema, so every field is optional.
export function parseClaudeOutput(text) {
  const fields = { result: null, is_error: null, num_turns: null, total_cost_usd: null, duration_ms: null, permission_denials: null };
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    // Some versions print log lines first; take the last line that parses.
    for (const line of String(text).trim().split("\n").reverse()) {
      try {
        obj = JSON.parse(line);
        break;
      } catch {
        // keep looking
      }
    }
  }
  if (Array.isArray(obj)) obj = obj.findLast?.((o) => o?.type === "result") ?? obj.at(-1);
  if (!obj || typeof obj !== "object") return { parsed: false, ...fields };

  return {
    parsed: true,
    result: typeof obj.result === "string" ? obj.result : null,
    is_error: typeof obj.is_error === "boolean" ? obj.is_error : null,
    num_turns: typeof obj.num_turns === "number" ? obj.num_turns : null,
    total_cost_usd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : null,
    duration_ms: typeof obj.duration_ms === "number" ? obj.duration_ms : null,
    permission_denials: Array.isArray(obj.permission_denials) ? obj.permission_denials.length : null,
  };
}

// The CLI's version line, or null when `claude --version` fails.
export function claudeVersion(cmd = "claude") {
  const r = run(cmd, ["--version"]);
  return r.code === 0 ? r.stdout.trim() || "unknown" : null;
}

export async function runClaude({ cmd, prompt, model, maxTurns, cwd, timeoutMs, stdoutFile, stderrFile, profileFile = null, env: baseEnv, marker = null }) {
  // LEARNING_LOOP=0 keeps a target's opt-in Stop hook from running the gate a
  // second time; the runner is the gate here.
  const env = { ...baseEnv, LEARNING_LOOP: "0" };
  const args = buildClaudeArgs({ prompt, model, maxTurns });
  // The allowlist limits which tools Claude may call, but allowed commands such
  // as npm test run code Claude wrote. The sandbox limits what that code can do.
  const call = profileFile ? wrap(profileFile, cmd, args) : { cmd, args };
  return runToFiles(call.cmd, call.args, { cwd, env, stdoutFile, stderrFile, timeoutMs, marker });
}
