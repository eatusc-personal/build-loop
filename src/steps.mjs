// Steps-file parsing. Pure.
//
// A steps file is Markdown. Each level-2 heading starts a step, and the text
// under it is that step's prompt. Text before the first step (after an
// optional level-1 title) is shared context sent with every step. Inside a
// step, a line starting with `DONE WHEN:` or `ALLOWED:` begins a trailer that
// runs until the next trailer or the end of the step. Headings and trailers
// inside fenced code blocks are ordinary text. In the shared context, a line
// starting with `PROTECTED:` lists globs no step may change (see gateguard.mjs);
// it is taken out of the context text. It may appear more than once.

// A fence opens with 3+ backticks or tildes and closes only on a line of the
// same character, at least as long, with nothing else after it (CommonMark).
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function fenceTracker() {
  let open = null; // { char, length } while inside a fenced block
  return (line) => {
    const m = FENCE.exec(line);
    if (!m) return open !== null;
    const run = m[1];
    if (open === null) {
      if (run[0] === "`" && m[2].includes("`")) return false; // not a fence per CommonMark
      open = { char: run[0], length: run.length };
      return true;
    }
    if (run[0] === open.char && run.length >= open.length && m[2].trim() === "") {
      open = null;
      return true; // the closing line itself is still part of the block
    }
    return true;
  };
}
const STEP_HEADING = /^##\s+(.+?)\s*#*\s*$/;
const TITLE_HEADING = /^#\s+(.+?)\s*#*\s*$/;
const TRAILER = /^(DONE WHEN|ALLOWED):\s?(.*)$/;
const PROTECTED = /^PROTECTED:\s?(.*)$/;

function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end).join("\n");
}

function parseStepBody(lines) {
  const body = [];
  const trailers = { "DONE WHEN": null, ALLOWED: null };
  let current = null; // name of the trailer being collected, or null for body
  const inFence = fenceTracker();

  for (const line of lines) {
    const match = !inFence(line) && TRAILER.exec(line);
    if (match) {
      current = match[1];
      trailers[current] = [match[2]];
      continue;
    }
    if (current) trailers[current].push(line);
    else body.push(line);
  }

  const doneWhen = trailers["DONE WHEN"] ? trimBlankLines(trailers["DONE WHEN"]) : null;
  const allowed = trailers.ALLOWED
    ? trailers.ALLOWED.join(",")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : null;

  return {
    body: trimBlankLines(body),
    doneWhen: doneWhen || null,
    // A present but empty ALLOWED: stays [] so preflight can refuse it; only a
    // missing trailer means any path may change.
    allowed,
  };
}

export function parseSteps(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let title = null;
  const contextLines = [];
  const protectedPaths = [];
  const rawSteps = [];
  const inFence = fenceTracker();

  for (const line of lines) {
    const fenced = inFence(line);
    const step = !fenced && STEP_HEADING.exec(line);
    if (step) {
      rawSteps.push({ heading: step[1], lines: [] });
      continue;
    }
    if (rawSteps.length) {
      rawSteps[rawSteps.length - 1].lines.push(line);
      continue;
    }
    const titleMatch = !fenced && title === null && contextLines.every((l) => l.trim() === "") && TITLE_HEADING.exec(line);
    const protectMatch = !fenced && PROTECTED.exec(line);
    if (titleMatch) title = titleMatch[1];
    else if (protectMatch) protectedPaths.push(...protectMatch[1].split(",").map((p) => p.trim()).filter(Boolean));
    else contextLines.push(line);
  }

  return {
    title,
    context: trimBlankLines(contextLines) || null,
    protected: protectedPaths,
    steps: rawSteps.map((s, i) => ({ index: i + 1, heading: s.heading, ...parseStepBody(s.lines) })),
  };
}
