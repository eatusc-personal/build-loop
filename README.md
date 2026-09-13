# build-loop

`build-loop` works through a Markdown file of build steps against a repo, one step at a time, in a private git worktree. For each step it runs the Claude CLI headless, then runs the repo's own `npm run check`. A green gate commits the step; a red one retries with the failure fed back, a bounded number of times. When it stops it leaves a branch and a report, and a person decides whether to take the branch. It replaces sitting in a session pasting the next step. It does not replace review.

Node 20, zero runtime dependencies.

## The rules it keeps

1. **The target owns the gate.** Pass or fail is the exit code of `npm run check` in the target repo. The runner never edits it and does not know what it runs.
2. **Every run is isolated.** Each run gets its own worktree and `loop/<run-id>` branch cut from the base branch. Your checkout, its branch, and gitignored files such as `.env.local` are never touched or copied.
3. **Retries are bounded.** A step gets a fixed number of attempts and each Claude call has a wall-clock timeout. The run stops at the first step that uses up its attempts, because later steps build on earlier ones.
4. **Only evidence counts.** A step lands when the working tree changed and the gate passed. What Claude says it did is saved but never used to decide anything, and the files listed in the report come from git.
5. **Scope is declared and checked.** A step can list the paths it may change. Touching anything else fails the attempt before the gate even runs, which catches an agent working around a deny rule with the shell.
6. **Every run leaves a handoff.** `report.md` says what landed, what failed and why, what it cost, and gives the exact commands to review, take, or discard the branch.

## Command line

```
node bin/loop.mjs --target <abs path> --steps <file> [options]
node bin/loop.mjs clean --target <abs path> [--base <branch>]

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
  --claude-cmd <path>    command to run instead of `claude`; also read
                         from env BUILD_LOOP_CLAUDE
```

`npm link` in this folder puts `build-loop` on your PATH.

It refuses to start, with a one-line reason and exit code 2, when the target has uncommitted changes, the base branch does not exist, `package.json` on the base branch has no `check` script, `claude --version` fails (unless `--claude-cmd` is given), or the steps file has no steps.

`clean` removes loop worktrees whose branch is merged into the base branch or has been deleted. It keeps branches, run logs, and reports, and prints the command to delete a merged branch.

State lives under `~/.build-loop/` (override with `BUILD_LOOP_HOME`):

```
~/.build-loop/worktrees/<target folder name>/<run-id>/   the worktree
~/.build-loop/runs/<target folder name>/<run-id>/        report.md, state.json, logs
```

`<run-id>` is `YYYYMMDD-HHMMSS`.

## Steps file format

```markdown
# Interview Drill log: merge instead of replace

Anything between the title and the first step is shared context,
sent with every step.

## Step 1: Add a merge endpoint to the log route

Prose describing the step. Any length. Code blocks are fine, and headings
or trailer lines inside a code block are left alone.

DONE WHEN: `npm run check` is green and the four new test cases exist.
This can run over several lines.

ALLOWED: app/api/interview-drill/log/route.js, tests/unit/interview-drill-*.test.js

## Step 2: Log the change

...
```

- Each `## ` heading is a step. Steps run in file order, and the heading becomes the commit subject as `loop: <heading>`.
- `DONE WHEN:` is appended to the prompt as the finish line. Optional.
- `ALLOWED:` is a comma-separated list of globs relative to the repo root (`*` within a path segment, `**` across directories, `?` for one character). If present, every changed file must match one. If absent, any file may change.

## What Claude is given

The prompt for an attempt is `src/preamble.md` (edit it freely, it is read at run time), then the shared context, the step, `DONE WHEN`, and the allowed paths. From the second attempt on it also gets the last 60 lines of the failed gate log, or the list of out-of-scope files, or a note that the last attempt changed nothing or timed out. The previous attempt's changes stay in the tree.

Claude runs in the worktree, so the target's `CLAUDE.md` and `.claude/settings.json` deny list apply. It runs with `--permission-mode dontAsk` and a fixed allow list: file reading and editing tools, `npm run check`, `npm test`, `npx vitest`, `npx eslint`, and read-only `git diff`, `git status`, `git log`, `ls`, and `cat`. Anything else is denied without prompting. `LEARNING_LOOP=0` is set so a target's opt-in Stop hook does not run the gate a second time.

## Reading a report

The runner prints one timestamped line per event, then the report path and the branch name as the last two lines. The report has:

- the outcome (`all steps landed`, `stopped`, `finished with failures`, `refused` for a red baseline, `dry run`, `interrupted`, or `error`), the base commit, branch, worktree, model, times, and total cost;
- one row per step: `landed`, `failed`, or `skipped`, attempts used, the failure reason (`gate`, `scope: <paths>`, `no changes`, `timeout`), the commit, and the files changed with line counts;
- the last 40 lines of the gate log for a failed step, or of the baseline or install log if the run never started;
- **Review it**, **Take it**, and **Discard it** commands.

Read the report, then the diff, then decide. Per-attempt prompts, Claude JSON output, stderr, and gate logs are next to the report in the run folder. If a step failed, fix the steps file and run again rather than changing the runner.

## What it will not do

- Merge, push, or open a pull request.
- Edit the gate or decide pass or fail any other way.
- Touch your checkout, its branch, or its uncommitted work.
- Copy gitignored files such as `.env.local` into the worktree.
- Start from a red baseline, since it could not tell its failures from inherited ones.
- Use `--dangerously-skip-permissions`.

## Development

```
npm test
```

Unit tests cover argument parsing, steps-file parsing, glob matching, prompt assembly, output parsing, and report rendering. Integration tests run `bin/loop.mjs` end to end against throwaway git repos with `tests/fake-claude.mjs` in place of the Claude CLI. The real `claude` is never run by the tests.
