// Steps-file parsing. Pure.
//
// A steps file is Markdown. Each level-2 heading starts a step, and the text
// under it is that step's prompt. Text before the first step (after an
// optional level-1 title) is shared context sent with every step. Inside a
// step, a line starting with `DONE WHEN:` or `ALLOWED:` begins a trailer that
// runs until the next trailer or the end of the step. Headings and trailers
// inside fenced code blocks are ordinary text.

const FENCE = /^\s*(```|~~~)/;
const STEP_HEADING = /^##\s+(.+?)\s*#*\s*$/;
const TITLE_HEADING = /^#\s+(.+?)\s*#*\s*$/;
const TRAILER = /^(DONE WHEN|ALLOWED):\s?(.*)$/;

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
  let inFence = false;

  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const match = !inFence && TRAILER.exec(line);
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
    allowed: allowed && allowed.length ? allowed : null,
  };
}

export function parseSteps(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let title = null;
  const contextLines = [];
  const rawSteps = [];
  let inFence = false;

  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const step = !inFence && STEP_HEADING.exec(line);
    if (step) {
      rawSteps.push({ heading: step[1], lines: [] });
      continue;
    }
    if (rawSteps.length) {
      rawSteps[rawSteps.length - 1].lines.push(line);
      continue;
    }
    const titleMatch = !inFence && title === null && contextLines.every((l) => l.trim() === "") && TITLE_HEADING.exec(line);
    if (titleMatch) title = titleMatch[1];
    else contextLines.push(line);
  }

  return {
    title,
    context: trimBlankLines(contextLines) || null,
    steps: rawSteps.map((s, i) => ({ index: i + 1, heading: s.heading, ...parseStepBody(s.lines) })),
  };
}
