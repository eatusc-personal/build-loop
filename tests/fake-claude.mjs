#!/usr/bin/env node
// Stand-in for the Claude CLI in integration tests. It ignores its flags and
// follows a plan from the environment:
//
//   FAKE_CLAUDE_PLAN   JSON array of actions, one per call; the last repeats.
//                      { "do": "write", "path": "file", "content": "..." }
//                      { "do": "nothing" }
//                      { "do": "sleep", "ms": 60000 }
//   FAKE_CLAUDE_STATE  directory for the call counter and what each call saw:
//                      prompt-<n>.txt, args-<n>.json, pid-<n>.txt
//
// Then it prints a minimal JSON object shaped like `claude -p --output-format json`.

import fs from "node:fs";
import path from "node:path";

const stateDir = process.env.FAKE_CLAUDE_STATE;
const plan = JSON.parse(process.env.FAKE_CLAUDE_PLAN || '[{"do":"nothing"}]');

const counterFile = path.join(stateDir, "calls");
const call = Number(fs.existsSync(counterFile) ? fs.readFileSync(counterFile, "utf8") : 0) + 1;
fs.writeFileSync(counterFile, String(call));

const args = process.argv.slice(2);
const promptIndex = args.indexOf("-p");
fs.writeFileSync(path.join(stateDir, `prompt-${call}.txt`), promptIndex >= 0 ? args[promptIndex + 1] : "");
fs.writeFileSync(path.join(stateDir, `args-${call}.json`), JSON.stringify(args));
fs.writeFileSync(path.join(stateDir, `pid-${call}.txt`), String(process.pid));
fs.writeFileSync(path.join(stateDir, `env-${call}.json`), JSON.stringify({ LEARNING_LOOP: process.env.LEARNING_LOOP ?? null }));

const action = plan[Math.min(call, plan.length) - 1];

if (action.do === "write") {
  const target = path.join(process.cwd(), action.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, action.content ?? "");
} else if (action.do === "sleep") {
  await new Promise((resolve) => setTimeout(resolve, action.ms));
}

process.stdout.write(
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0.01,
    duration_ms: 5,
    result: `fake call ${call}: ${action.do}`,
  }) + "\n"
);
