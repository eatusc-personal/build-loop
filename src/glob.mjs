// Glob matching for ALLOWED paths and the scope check. Pure, no dependencies.
//
//   `*`   any run of characters except `/`
//   `**`  any run of characters including `/`; `**/` also matches zero directories
//   `?`   one character except `/`
// Patterns and paths are relative to the repo root, with forward slashes.

function escapeRegExp(ch) {
  return /[\\^$.|+()[\]{}]/.test(ch) ? `\\${ch}` : ch;
}

export function globToRegExp(pattern) {
  const p = pattern.replace(/^\.\//, "");
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(filePath, patterns) {
  const p = filePath.replace(/^\.\//, "");
  return patterns.some((pattern) => globToRegExp(pattern).test(p));
}

// Paths that fall outside `allowed`. An absent or empty list allows everything.
export function outOfScope(paths, allowed) {
  if (!allowed || allowed.length === 0) return [];
  return paths.filter((p) => !matchesAny(p, allowed));
}
