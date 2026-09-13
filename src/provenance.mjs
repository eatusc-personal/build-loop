// Where and how a run happened, so runs from more than one machine can share
// one index. resolveMachine and sha256 are pure; the rest reads the system.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./exec.mjs";

// 1: runs from before provenance was recorded (state.json has no schemaVersion).
// 2: machine, repo origin, UTC times, runner and tool versions, steps snapshot.
export const SCHEMA_VERSION = 2;

export const RUNNER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

const readOrNull = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

// The machine name, in order of preference:
//   1. BUILD_LOOP_MACHINE, for an explicit override
//   2. the one word in the agent library's .machine file (laptop, studio), so
//      build-loop names machines the same way the agent library does
//   3. the hostname without .local
export function resolveMachine({ env = {}, home, hostname, readFile = readOrNull }) {
  const host = hostname ?? "";
  const override = env.BUILD_LOOP_MACHINE?.trim();
  if (override) return { name: override, source: "BUILD_LOOP_MACHINE", hostname: host };

  const file = env.BUILD_LOOP_MACHINE_FILE || path.join(home ?? "", "code", "agent-library", ".machine");
  const word = (readFile(file) ?? "").trim().split(/\s+/)[0];
  if (word) return { name: word, source: file, hostname: host };

  return { name: host.replace(/\.local$/, "") || "unknown", source: "hostname", hostname: host };
}

export function currentMachine(env = process.env) {
  return resolveMachine({ env, home: os.homedir(), hostname: os.hostname() });
}

export function runnerVersion(root = RUNNER_ROOT) {
  const head = run("git", ["-C", root, "rev-parse", "HEAD"]);
  if (head.code !== 0) return { commit: null, dirty: null };
  const status = run("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"]);
  return { commit: head.stdout.trim(), dirty: status.stdout.trim() !== "" };
}

export function collectProvenance({ opts, env = process.env, stepsText, claudeVersion }) {
  let user = null;
  try {
    user = os.userInfo().username;
  } catch {
    // Some sandboxes have no passwd entry.
  }
  const origin = run("git", ["-C", opts.target, "remote", "get-url", "origin"]);
  return {
    schemaVersion: SCHEMA_VERSION,
    machine: currentMachine(env),
    user,
    repo: { origin: origin.code === 0 ? origin.stdout.trim() : null },
    runner: runnerVersion(),
    versions: {
      node: process.version,
      claude: opts.claudeCmdGiven ? `custom command: ${opts.claudeCmd}` : claudeVersion,
    },
    stepsFile: { source: opts.steps, snapshot: "steps.md", sha256: sha256(stepsText) },
  };
}
