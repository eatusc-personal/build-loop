import { describe, expect, it } from "vitest";
import { assemblePrompt, loadPreamble, tailLines } from "../../src/prompt.mjs";

const step = {
  index: 1,
  heading: "Step 1: Add PUT",
  body: "Add a PUT handler.",
  doneWhen: "the gate is green",
  allowed: ["app/api/**", "tests/unit/x.test.js"],
};

describe("assemblePrompt", () => {
  it("orders preamble, context, step, DONE WHEN, and ALLOWED on the first attempt", () => {
    const prompt = assemblePrompt({ preamble: "PREAMBLE", title: "The plan", context: "CONTEXT", step, attempt: 1, attempts: 3 });
    expect(prompt).toBe(
      [
        "PREAMBLE",
        "# The plan\n\nCONTEXT",
        "## Step 1: Add PUT\n\nAdd a PUT handler.",
        "DONE WHEN: the gate is green",
        "You may only change these paths:\n\n- app/api/**\n- tests/unit/x.test.js",
      ].join("\n\n") + "\n"
    );
    expect(prompt).not.toContain("Attempt");
  });

  it("uses a generic heading for context when the file has no title", () => {
    expect(assemblePrompt({ preamble: "P", context: "C", step })).toContain("P\n\n# Context for every step\n\nC\n\n## Step 1");
  });

  it("omits optional sections that are absent", () => {
    const prompt = assemblePrompt({
      preamble: "P",
      context: null,
      step: { ...step, doneWhen: null, allowed: null },
    });
    expect(prompt).toBe("P\n\n## Step 1: Add PUT\n\nAdd a PUT handler.\n");
  });

  it("feeds the last 60 gate log lines back on a later attempt", () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const prompt = assemblePrompt({
      preamble: "P",
      step,
      attempt: 2,
      attempts: 3,
      previous: { reason: "gate", logTail: log },
    });
    expect(prompt).toContain("Attempt 2 of 3. Your previous attempt is still in the working tree. The gate failed.");
    expect(prompt).toContain("line 41\n");
    expect(prompt).toContain("line 100");
    expect(prompt).not.toContain("line 40\n");
  });

  it("names the out-of-scope files instead of a log after a scope failure", () => {
    const prompt = assemblePrompt({
      preamble: "P",
      step,
      attempt: 3,
      attempts: 3,
      previous: { reason: "scope", paths: ["lib/projects.js", "docs/log.md"] },
    });
    expect(prompt).toContain("Attempt 3 of 3.");
    expect(prompt).toContain("outside the allowed paths");
    expect(prompt).toContain("- lib/projects.js\n- docs/log.md");
    expect(prompt).not.toContain("The gate failed");
  });

  it("explains no-change and timeout failures", () => {
    expect(assemblePrompt({ preamble: "P", step, attempt: 2, attempts: 2, previous: { reason: "no changes" } })).toContain("changed no files");
    expect(assemblePrompt({ preamble: "P", step, attempt: 2, attempts: 2, previous: { reason: "timeout" } })).toContain("time limit");
  });
});

describe("tailLines and loadPreamble", () => {
  it("keeps the last n lines and ignores trailing whitespace", () => {
    expect(tailLines("a\nb\nc\n\n", 2)).toBe("b\nc");
    expect(tailLines(undefined, 5)).toBe("");
  });

  it("reads the preamble from src/preamble.md", () => {
    const preamble = loadPreamble();
    expect(preamble).toContain("unattended build loop");
    expect(preamble).toContain("npm run check");
    expect(preamble).not.toContain("\u2014");
  });
});
