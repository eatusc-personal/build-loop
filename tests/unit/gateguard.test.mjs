import { describe, expect, it } from "vitest";
import { compareGate, reachableScripts } from "../../src/gateguard.mjs";
import { parseSteps } from "../../src/steps.mjs";

const pkg = (scripts) => JSON.stringify({ name: "x", scripts });

describe("reachableScripts", () => {
  it("follows npm run, npm test, runner words, and pre/post hooks", () => {
    const scripts = {
      check: "npm run lint && npm test && run-s types",
      lint: "eslint .",
      test: "vitest run",
      pretest: "node setup.mjs",
      types: "concurrently \"npm:tsc\"",
      tsc: "tsc --noEmit",
      precheck: "node pre.mjs",
      dev: "next dev",
    };
    expect(reachableScripts([scripts])).toEqual(["check", "lint", "precheck", "pretest", "test", "tsc", "types"]);
  });

  it("follows names from either version, so a newly added script is still compared", () => {
    expect(reachableScripts([{ check: "node a.mjs" }, { check: "npm run fake", fake: "true" }])).toEqual(["check", "fake"]);
  });
});

describe("compareGate", () => {
  const base = { packageJson: pkg({ check: "npm run lint && node check.mjs", lint: "eslint .", dev: "next dev" }), npmrc: null };

  it("passes an unchanged gate and changes to scripts the gate does not run", () => {
    expect(compareGate({ base, current: base })).toEqual([]);
    const current = { packageJson: pkg({ check: "npm run lint && node check.mjs", lint: "eslint .", dev: "next dev --turbo", start: "x" }), npmrc: null };
    expect(compareGate({ base, current })).toEqual([]);
  });

  it("flags scripts.check replaced with true", () => {
    const current = { packageJson: pkg({ check: "true", lint: "eslint .", dev: "next dev" }), npmrc: null };
    expect(compareGate({ base, current })).toEqual(["package.json scripts.check"]);
  });

  it("flags a script the check invokes, and a new pre hook", () => {
    const current = { packageJson: pkg({ check: "npm run lint && node check.mjs", lint: "true", precheck: "node x.mjs", dev: "next dev" }), npmrc: null };
    expect(compareGate({ base, current })).toEqual(["package.json scripts.lint", "package.json scripts.precheck"]);
  });

  it("flags invalid package.json and a changed .npmrc", () => {
    expect(compareGate({ base, current: { packageJson: "{", npmrc: null } })).toEqual(["package.json (not valid JSON)"]);
    expect(compareGate({ base, current: { packageJson: base.packageJson, npmrc: "script-shell=/usr/bin/true\n" } })).toEqual([".npmrc"]);
  });

  it("flags changed paths that match PROTECTED globs", () => {
    expect(compareGate({ base, current: base, changed: ["check.mjs", "src/a.js", "tests/x.test.js"], protect: ["check.mjs", "tests/**"] })).toEqual([
      "check.mjs",
      "tests/x.test.js",
    ]);
  });
});

describe("PROTECTED in the steps file", () => {
  it("is read from the shared context and taken out of it", () => {
    const parsed = parseSteps("# T\n\nContext.\n\nPROTECTED: check.mjs, eslint.config.mjs\nPROTECTED: tests/**\n\n## Step 1\n\nDo it.\n");
    expect(parsed.protected).toEqual(["check.mjs", "eslint.config.mjs", "tests/**"]);
    expect(parsed.context).toBe("Context.");
  });
});
