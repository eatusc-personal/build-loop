import { describe, expect, it } from "vitest";
import { renderReport } from "../../src/report.mjs";
import { resolveMachine, sha256 } from "../../src/provenance.mjs";

const files = (map) => (file) => (file in map ? map[file] : null);

describe("resolveMachine", () => {
  it("prefers BUILD_LOOP_MACHINE", () => {
    expect(
      resolveMachine({
        env: { BUILD_LOOP_MACHINE: " studio " },
        home: "/Users/me",
        hostname: "mac-studio.local",
        readFile: files({ "/Users/me/code/agent-library/.machine": "laptop\n" }),
      })
    ).toEqual({ name: "studio", source: "BUILD_LOOP_MACHINE", hostname: "mac-studio.local" });
  });

  it("reads the agent library's .machine file next", () => {
    expect(
      resolveMachine({
        env: { BUILD_LOOP_MACHINE: "" },
        home: "/Users/me",
        hostname: "erics-MacBook-Pro-2.local",
        readFile: files({ "/Users/me/code/agent-library/.machine": "laptop\n" }),
      })
    ).toEqual({ name: "laptop", source: "/Users/me/code/agent-library/.machine", hostname: "erics-MacBook-Pro-2.local" });
  });

  it("honors BUILD_LOOP_MACHINE_FILE and takes only the first word", () => {
    const m = resolveMachine({
      env: { BUILD_LOOP_MACHINE_FILE: "/etc/machine" },
      home: "/Users/me",
      hostname: "h",
      readFile: files({ "/etc/machine": "studio extra words\n" }),
    });
    expect(m.name).toBe("studio");
    expect(m.source).toBe("/etc/machine");
  });

  it("falls back to the hostname without .local", () => {
    expect(resolveMachine({ env: {}, home: "/Users/me", hostname: "mac-studio.local", readFile: files({}) })).toEqual({
      name: "mac-studio",
      source: "hostname",
      hostname: "mac-studio.local",
    });
    expect(resolveMachine({ env: {}, home: "/x", hostname: "", readFile: files({}) }).name).toBe("unknown");
  });
});

describe("sha256", () => {
  it("hashes text", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("report provenance rows", () => {
  const base = {
    target: "/repo",
    base: "main",
    baseCommit: "abc",
    branch: "loop/1",
    worktree: "/wt",
    runDir: "/runs/1",
    model: "sonnet",
    steps: [],
  };

  it("shows machine, origin, steps file, and runner when recorded", () => {
    const md = renderReport({
      ...base,
      machine: { name: "studio", source: "hostname", hostname: "mac-studio.local" },
      repo: { origin: "https://github.com/me/app.git" },
      stepsFile: { source: "/repo/docs/steps.md", snapshot: "steps.md", sha256: "0123456789abcdef" },
      runner: { commit: "176ca1f00000", dirty: true },
    });
    expect(md).toContain("| Machine | studio (mac-studio.local) |");
    expect(md).toContain("| Target | `/repo` (https://github.com/me/app.git) |");
    expect(md).toContain("| Steps file | `/repo/docs/steps.md` (copy saved as steps.md, sha256 `0123456789ab`) |");
    expect(md).toContain("| Runner | build-loop `176ca1f` with uncommitted changes |");
  });

  it("still renders a run recorded before provenance existed", () => {
    const md = renderReport(base);
    expect(md).toContain("| Machine | not recorded |");
    expect(md).toContain("| Target | `/repo` |");
    expect(md).not.toContain("| Steps file |");
  });
});
