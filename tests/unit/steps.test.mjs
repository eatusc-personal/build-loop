import { describe, expect, it } from "vitest";
import { parseSteps } from "../../src/steps.mjs";

describe("parseSteps", () => {
  it("splits level-2 headings into steps and keeps shared context", () => {
    const md = `# Title here

Shared context
for every step.

## Step 1: First

Do the first thing.

## Step 2: Second

Do the second thing.
`;
    const parsed = parseSteps(md);
    expect(parsed.title).toBe("Title here");
    expect(parsed.context).toBe("Shared context\nfor every step.");
    expect(parsed.steps).toEqual([
      { index: 1, heading: "Step 1: First", body: "Do the first thing.", doneWhen: null, allowed: null },
      { index: 2, heading: "Step 2: Second", body: "Do the second thing.", doneWhen: null, allowed: null },
    ]);
  });

  it("returns no steps and no context for an empty file", () => {
    expect(parseSteps("")).toEqual({ title: null, context: null, protected: [], steps: [] });
    expect(parseSteps("# Only a title\n\nsome prose\n").steps).toEqual([]);
  });

  it("parses trailers out of the body, including a multi-line DONE WHEN", () => {
    const md = `## Step 1: Thing

Body paragraph one.

Body paragraph two.

DONE WHEN: the gate is green
and the four tests exist.

ALLOWED: app/api/**, tests/unit/a.test.js
`;
    const [step] = parseSteps(md).steps;
    expect(step.body).toBe("Body paragraph one.\n\nBody paragraph two.");
    expect(step.doneWhen).toBe("the gate is green\nand the four tests exist.");
    expect(step.allowed).toEqual(["app/api/**", "tests/unit/a.test.js"]);
  });

  it("accepts ALLOWED spanning lines and trailers in either order", () => {
    const md = `## Step
Body.
ALLOWED: a/**,
  b.js
DONE WHEN: done
`;
    const [step] = parseSteps(md).steps;
    expect(step.allowed).toEqual(["a/**", "b.js"]);
    expect(step.doneWhen).toBe("done");
    expect(step.body).toBe("Body.");
  });

  it("treats headings and trailers inside code blocks as body text", () => {
    const md = `## Step 1: With code

Example:

\`\`\`md
## Not a step
DONE WHEN: not a trailer
ALLOWED: nope/**
\`\`\`

After the block.

DONE WHEN: real
`;
    const { steps } = parseSteps(md);
    expect(steps).toHaveLength(1);
    expect(steps[0].body).toContain("## Not a step");
    expect(steps[0].body).toContain("DONE WHEN: not a trailer");
    expect(steps[0].body).toContain("After the block.");
    expect(steps[0].doneWhen).toBe("real");
    expect(steps[0].allowed).toBeNull();
  });

  it("keeps an inner three-backtick block inside a four-backtick fence", () => {
    const md = `## Step 1: Document the format

Show this example:

\`\`\`\`md
A steps file shows code like this, and the closing fence is below:
\`\`\`

## Example step

ALLOWED: nope/**
\`\`\`\`

ALLOWED: docs/**
`;
    const { steps } = parseSteps(md);
    expect(steps.map((s) => s.heading)).toEqual(["Step 1: Document the format"]);
    expect(steps[0].body).toContain("## Example step");
    expect(steps[0].body).toContain("ALLOWED: nope/**");
    expect(steps[0].allowed).toEqual(["docs/**"]);
  });

  it("closes a tilde fence only with tildes, and ignores a closing line with trailing text", () => {
    const md = `## Step 1

~~~
\`\`\`
## Still inside
~~~ not a close
~~~

## Step 2
`;
    const { steps } = parseSteps(md);
    expect(steps.map((s) => s.heading)).toEqual(["Step 1", "Step 2"]);
    expect(steps[0].body).toContain("## Still inside");
  });

  it("reads CRLF files the same as LF", () => {
    const { steps } = parseSteps("## Step 1\r\nBody\r\nALLOWED: a.js\r\n");
    expect(steps[0]).toMatchObject({ body: "Body", allowed: ["a.js"] });
  });

  it("keeps a present but empty ALLOWED as an empty list, and a missing one as null", () => {
    const { steps } = parseSteps("## Empty\nBody\nALLOWED:\n\n## Missing\nBody\n");
    expect(steps[0].allowed).toEqual([]);
    expect(steps[1].allowed).toBeNull();
  });

  it("does not take a level-3 heading as a step", () => {
    const { steps } = parseSteps("## Step\n### Sub\ntext\n");
    expect(steps).toHaveLength(1);
    expect(steps[0].body).toBe("### Sub\ntext");
  });
});
