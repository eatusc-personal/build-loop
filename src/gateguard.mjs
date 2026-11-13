// Gate protection: what the runner enforces about `npm run check`, beyond
// asking Claude not to touch it. Pure apart from reading files in gateChanges.
//
// Enforced, against the run's base commit:
//   - the `check` script and every script it reaches (see reachableScripts),
//     including their pre and post scripts;
//   - the repo-root `.npmrc`, which can change how npm runs scripts at all
//     (for example `script-shell` or `ignore-scripts`);
//   - any path matching a PROTECTED: glob from the steps file.
// Not enforced: the files those scripts run (check.mjs, test files, lint and
// test configs) unless the steps file lists them under PROTECTED:.

import fs from "node:fs";
import path from "node:path";
import { matchesAny } from "./glob.mjs";

// npm's own aliases for `npm test`.
const ALIASES = { t: "test", tst: "test" };

export function parseScripts(packageJsonText) {
  if (packageJsonText === null || packageJsonText === undefined) return {};
  try {
    const scripts = JSON.parse(packageJsonText)?.scripts;
    return scripts && typeof scripts === "object" ? scripts : {};
  } catch {
    return null;
  }
}

// Script names a command string mentions. Any word that names a script counts,
// which covers `npm run lint`, `npm test`, `run-s lint test`, and
// `concurrently "npm:lint"`. A glob such as `run-s lint:*` is not expanded.
function mentionedScripts(command, names) {
  const words = String(command)
    .split(/[\s;&|()'"`]+/)
    .map((w) => w.replace(/^npm:/, ""))
    .filter(Boolean);
  const found = new Set();
  for (const w of words) {
    const name = ALIASES[w] ?? w;
    if (names.has(name)) found.add(name);
  }
  return found;
}

// Every script `npm run check` can run: check, its pre and post scripts, and
// any script those mention, transitively. Names are taken from all the given
// script maps, so a script added in one version is still followed.
export function reachableScripts(scriptMaps, start = "check") {
  const names = new Set(scriptMaps.flatMap((m) => Object.keys(m ?? {})));
  names.add(start);
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const hook of [`pre${name}`, `post${name}`]) if (names.has(hook)) queue.push(hook);
    for (const m of scriptMaps) {
      if (typeof m?.[name] === "string") for (const next of mentionedScripts(m[name], names)) queue.push(next);
    }
  }
  return [...seen].sort();
}

// What changed in the gate between the base commit and the worktree, as a
// list of readable labels such as `package.json scripts.check`. Empty when
// the gate is as the base commit had it.
//   base: { packageJson, npmrc } text at the base commit (null when absent)
//   current: the same, read from the worktree
//   changed: paths that differ from HEAD; protect: PROTECTED: globs
export function compareGate({ base, current, changed = [], protect = [] }) {
  const out = [];
  const baseScripts = parseScripts(base.packageJson) ?? {};
  const curScripts = parseScripts(current.packageJson);
  if (curScripts === null) {
    out.push("package.json (not valid JSON)");
  } else {
    for (const name of reachableScripts([baseScripts, curScripts])) {
      if (baseScripts[name] !== curScripts[name]) out.push(`package.json scripts.${name}`);
    }
  }
  if ((base.npmrc ?? null) !== (current.npmrc ?? null)) out.push(".npmrc");
  if (protect.length) {
    for (const p of changed) if (matchesAny(p, protect) && !out.includes(p)) out.push(p);
  }
  return out;
}

const readOrNull = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

export function gateChanges(worktree, { base, changed, protect }) {
  const current = {
    packageJson: readOrNull(path.join(worktree, "package.json")),
    npmrc: readOrNull(path.join(worktree, ".npmrc")),
  };
  return compareGate({ base, current, changed, protect });
}
