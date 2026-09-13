import { describe, expect, it } from "vitest";
import { parseCli } from "../../src/args.mjs";

const base = ["--target", "/repo", "--steps", "/repo/steps.md"];

describe("parseCli", () => {
  it("applies defaults", () => {
    expect(parseCli(base)).toEqual({
      command: "run",
      target: "/repo",
      steps: "/repo/steps.md",
      base: "main",
      attempts: 3,
      maxTurns: 60,
      model: "sonnet",
      timeoutMinutes: 20,
      install: null,
      continueOnFail: false,
      dryRun: false,
      claudeCmd: null,
      claudeCmdGiven: false,
      sandbox: true,
      installTimeoutMinutes: 15,
      gateTimeoutMinutes: 15,
    });
  });

  it("reads every option", () => {
    const opts = parseCli([
      ...base,
      "--base", "dev",
      "--attempts", "5",
      "--max-turns", "10",
      "--model", "opus",
      "--timeout", "0.5",
      "--install", "true",
      "--continue-on-fail",
      "--dry-run",
      "--claude-cmd", "/bin/fake",
      "--no-sandbox",
    ]);
    expect(opts).toMatchObject({
      base: "dev",
      attempts: 5,
      maxTurns: 10,
      model: "opus",
      timeoutMinutes: 0.5,
      install: "true",
      continueOnFail: true,
      dryRun: true,
      claudeCmd: "/bin/fake",
      claudeCmdGiven: true,
      sandbox: false,
    });
    expect(parseCli([...base, "--install-timeout", "2", "--gate-timeout", "0.5"])).toMatchObject({ installTimeoutMinutes: 2, gateTimeoutMinutes: 0.5 });
  });

  it("falls back to BUILD_LOOP_CLAUDE, with the flag winning", () => {
    expect(parseCli(base, { BUILD_LOOP_CLAUDE: "/env/fake" }).claudeCmd).toBe("/env/fake");
    expect(parseCli([...base, "--claude-cmd", "/flag"], { BUILD_LOOP_CLAUDE: "/env" }).claudeCmd).toBe("/flag");
  });

  it("parses the clean command", () => {
    expect(parseCli(["clean", "--target", "/repo"])).toEqual({ command: "clean", target: "/repo", base: "main" });
  });

  it("rejects bad input with a one-line reason", () => {
    expect(() => parseCli(["--steps", "s.md"])).toThrow("--target is required");
    expect(() => parseCli(["--target", "rel", "--steps", "s.md"])).toThrow("absolute");
    expect(() => parseCli(["--target", "/repo"])).toThrow("--steps is required");
    expect(() => parseCli([...base, "--attempts", "0"])).toThrow("positive integer");
    expect(() => parseCli([...base, "--timeout", "soon"])).toThrow("positive number");
    expect(() => parseCli([...base, "--timeout=-1"])).toThrow("positive number");
    expect(() => parseCli([...base, "--bogus"])).toThrow();
    expect(() => parseCli(["merge", "--target", "/repo"])).toThrow("unknown command");
  });
});
