// The environment given to Claude, the gate, and the install command. Pure.
//
// Seatbelt does not filter environment variables, and network access stays on,
// so anything in the runner's environment (API keys, cloud credentials, tokens)
// could be read by agent-written code and sent elsewhere. Children get a short
// allowlist instead of a copy of everything.

export const BASE_ENV_NAMES = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TERM",
  "LANG",
  "TZ",
  // Only set by people who moved their Claude configuration; the CLI needs it then.
  "CLAUDE_CONFIG_DIR",
];

// BUILD_LOOP_PASS_ENV="NAME1,NAME2" adds names on purpose, for example an
// API key when the Claude CLI is not signed in through the Keychain.
export function childEnv(parent, extra = {}) {
  const pass = String(parent.BUILD_LOOP_PASS_ENV ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const env = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (BASE_ENV_NAMES.includes(name) || name.startsWith("LC_") || pass.includes(name)) env[name] = value;
  }
  return { ...env, ...extra };
}

export const PROC_MARKER = "BUILD_LOOP_PROC";

// Process ids whose environment carries this marker, from
// `ps -axE -ww -o pid=,command=` output. Used to find processes an attempt
// started in a new process group, which a process-group kill does not reach.
export function pidsWithMarker(psOutput, marker, selfPid) {
  const needle = `${PROC_MARKER}=${marker}`;
  const pids = [];
  for (const line of String(psOutput).split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === selfPid) continue;
    if (m[2].split(/\s+/).includes(needle)) pids.push(pid);
  }
  return pids;
}
