// The reviewable-diff rule: a change a person cannot read in `git diff` does
// not land. findControlChars and reviewProblems are pure; checkReviewable
// reads the worktree.

import fs from "node:fs";
import path from "node:path";
import { isBinaryForGit } from "./git.mjs";

export const TEXT_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".md", ".css",
  ".html", ".yaml", ".yml", ".txt", ".sh", ".sql",
]);

// Bytes 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F. Newline, carriage return, and tab are fine.
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

export function findControlChars(text) {
  const found = [];
  for (const match of text.matchAll(CONTROL)) {
    found.push({
      line: text.slice(0, match.index).split("\n").length,
      code: `0x${match[0].charCodeAt(0).toString(16).padStart(2, "0")}`,
    });
  }
  return found;
}

// files: [{ path, binary, text }], where binary is git's verdict on the new
// content and text is the file's content. Returns one message per problem file.
export function reviewProblems(files) {
  const problems = [];
  for (const f of files) {
    const hasTextExtension = TEXT_EXTENSIONS.has(path.extname(f.path).toLowerCase());
    if (f.binary && !hasTextExtension) continue; // an image or other real binary
    const hits = findControlChars(f.text ?? "");
    if (hits.length) {
      const where = hits.slice(0, 5).map((h) => `line ${h.line} (${h.code})`).join(", ");
      problems.push(`${f.path} ${where}${hits.length > 5 ? `, and ${hits.length - 5} more` : ""}`);
    } else if (f.binary) {
      problems.push(`${f.path} (git shows it as binary)`);
    }
  }
  return problems;
}

// Git is asked about the new content only (compared against an empty file), so
// an attempt that removes a stray byte from an existing file is not blocked by
// the byte it removed. Deleted files have nothing to show and are skipped.
export function checkReviewable(worktree, changedPaths) {
  const files = [];
  for (const rel of changedPaths) {
    const abs = path.join(worktree, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    files.push({ path: rel, binary: isBinaryForGit(worktree, rel), text: fs.readFileSync(abs, "utf8") });
  }
  return reviewProblems(files);
}
