// Command-line parsing. Pure: takes argv (without node and script) and an env
// object, returns options or throws an Error with a one-line message.

import { parseArgs as nodeParseArgs } from "node:util";
import path from "node:path";

export const USAGE = `build-loop --target <abs path> --steps <file> [options]
build-loop clean --target <abs path> [--base <branch>]
build-loop runs [--into <branch>]

  --base <branch>        branch to cut from            default: main
  --attempts <n>         attempts per step             default: 3
  --max-turns <n>        passed to claude --max-turns  default: 60
  --model <name>         passed to claude --model      default: sonnet
  --timeout <minutes>    per Claude call               default: 20
  --install <cmd>        run once in the new worktree  default: npm ci if
                         package-lock.json exists, else npm install
  --continue-on-fail     keep going past a failed step default: stop
  --dry-run              do everything except call Claude; print each
                         assembled prompt instead
  --claude-cmd <path>    command to run instead of \`claude\`; also read
                         from env BUILD_LOOP_CLAUDE
  --install-timeout <m>  install time limit, minutes   default: 15
  --gate-timeout <m>     per gate run, minutes         default: 15
  --no-sandbox           run Claude and the gate without the macOS sandbox
                         (not recommended; see README)`;

const OPTIONS = {
  target: { type: "string" },
  steps: { type: "string" },
  base: { type: "string" },
  attempts: { type: "string" },
  "max-turns": { type: "string" },
  model: { type: "string" },
  timeout: { type: "string" },
  install: { type: "string" },
  "continue-on-fail": { type: "boolean" },
  "dry-run": { type: "boolean" },
  "claude-cmd": { type: "string" },
  into: { type: "string" },
  "no-sandbox": { type: "boolean" },
  "install-timeout": { type: "string" },
  "gate-timeout": { type: "string" },
  help: { type: "boolean", short: "h" },
};

function positiveInt(name, raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got "${raw}"`);
  return n;
}

function positiveNumber(name, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number, got "${raw}"`);
  return n;
}

export function parseCli(argv, env = {}) {
  const { values, positionals } = nodeParseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });

  if (values.help) return { command: "help" };

  const command = positionals[0] ?? "run";
  if (!["run", "clean", "runs"].includes(command) || positionals.length > 1) {
    throw new Error(`unknown command "${positionals.join(" ")}"`);
  }

  // runs: rebuild the run index; decisions are checked against --into.
  if (command === "runs") return { command, into: values.into ?? "main" };

  if (!values.target) throw new Error("--target is required");
  if (!path.isAbsolute(values.target)) throw new Error("--target must be an absolute path");
  const target = path.resolve(values.target);
  const base = values.base ?? "main";

  if (command === "clean") return { command, target, base };

  if (!values.steps) throw new Error("--steps is required");

  const claudeCmd = values["claude-cmd"] ?? (env.BUILD_LOOP_CLAUDE || null);

  return {
    command,
    target,
    steps: path.resolve(values.steps),
    base,
    attempts: values.attempts === undefined ? 3 : positiveInt("attempts", values.attempts),
    maxTurns: values["max-turns"] === undefined ? 60 : positiveInt("max-turns", values["max-turns"]),
    model: values.model ?? "sonnet",
    timeoutMinutes: values.timeout === undefined ? 20 : positiveNumber("timeout", values.timeout),
    install: values.install ?? null,
    continueOnFail: Boolean(values["continue-on-fail"]),
    dryRun: Boolean(values["dry-run"]),
    claudeCmd,
    claudeCmdGiven: claudeCmd !== null,
    sandbox: !values["no-sandbox"],
    installTimeoutMinutes: values["install-timeout"] === undefined ? 15 : positiveNumber("install-timeout", values["install-timeout"]),
    gateTimeoutMinutes: values["gate-timeout"] === undefined ? 15 : positiveNumber("gate-timeout", values["gate-timeout"]),
  };
}
