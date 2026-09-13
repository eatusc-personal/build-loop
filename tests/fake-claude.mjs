#!/usr/bin/env node
// Stand-in for the Claude CLI in integration tests. It ignores its flags and
// follows a plan from the environment:
//
//   FAKE_CLAUDE_PLAN   JSON array of actions, one per call; the last repeats.
//                      { "do": "write", "path": "file", "content": "..." }
//                      { "do": "stage", "path": "file", "content": "..." }  write, then git add
//                      { "do": "copy", "from": "/abs/or/rel", "to": "file" }  read one file into another
//                      { "do": "nothing" }
//                      { "do": "sleep", "ms": 60000 }
//                      { "do": "orphan", "path": "file", "ms": 1500, "detached": true }
//                        start a background child that writes the file later, then exit
//                      { "do": "multi", "actions": [ ... ] }  several actions in one call
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
fs.writeFileSync(
  path.join(stateDir, `env-${call}.json`),
  JSON.stringify({ LEARNING_LOOP: process.env.LEARNING_LOOP ?? null, SECRET_TOKEN: process.env.SECRET_TOKEN ?? null, keys: Object.keys(process.env).sort() })
);

const action = plan[Math.min(call, plan.length) - 1];

async function perform(action) {
  // Paths resolve against the worktree, and absolute paths are used as given, so
  // a plan can try to reach outside the worktree.
  if (action.do === "write") {
    const target = path.resolve(process.cwd(), action.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, action.content ?? "");
  } else if (action.do === "multi") {
    for (const inner of action.actions) await perform(inner);
  } else if (action.do === "copy") {
    const to = path.resolve(process.cwd(), action.to);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, fs.readFileSync(path.resolve(process.cwd(), action.from)));
  } else if (action.do === "stage") {
    const { execFileSync } = await import("node:child_process");
    fs.writeFileSync(path.join(process.cwd(), action.path), action.content ?? "");
    execFileSync("git", ["add", action.path], { cwd: process.cwd() });
  } else if (action.do === "orphan") {
    const { spawn } = await import("node:child_process");
    const target = path.join(process.cwd(), action.path);
    const code = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(target)}, "late\\n"), ${action.ms});`;
    spawn(process.execPath, ["-e", code], { stdio: "ignore", detached: Boolean(action.detached) }).unref();
    fs.writeFileSync(path.join(stateDir, `orphan-${call}.txt`), target);
  } else if (action.do === "sleep") {
    await new Promise((resolve) => setTimeout(resolve, action.ms));
  }
}

await perform(action);

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
