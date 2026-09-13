import { describe, expect, it } from "vitest";
import { matchesAny, outOfScope } from "../../src/glob.mjs";

describe("matchesAny", () => {
  it("matches exact paths", () => {
    expect(matchesAny("docs/log.md", ["docs/log.md"])).toBe(true);
    expect(matchesAny("docs/log.mdx", ["docs/log.md"])).toBe(false);
    expect(matchesAny("./docs/log.md", ["docs/log.md"])).toBe(true);
  });

  it("keeps * inside one path segment", () => {
    expect(matchesAny("tests/unit/interview-drill-log.test.js", ["tests/unit/interview-drill-*.test.js"])).toBe(true);
    expect(matchesAny("tests/unit/deep/interview-drill-x.test.js", ["tests/unit/interview-drill-*.test.js"])).toBe(false);
    expect(matchesAny("src/a.js", ["*.js"])).toBe(false);
  });

  it("lets ** cross directories, including zero of them", () => {
    expect(matchesAny("app/api/interview-drill/log/route.js", ["app/api/interview-drill/**"])).toBe(true);
    expect(matchesAny("app/api/interview-drill/route.js", ["app/api/interview-drill/**"])).toBe(true);
    expect(matchesAny("app/api/notes/route.js", ["app/api/interview-drill/**"])).toBe(false);
    expect(matchesAny("route.js", ["**/route.js"])).toBe(true);
    expect(matchesAny("a/b/c/route.js", ["**/route.js"])).toBe(true);
    expect(matchesAny("a/b/c/route.js", ["a/**/route.js"])).toBe(true);
    expect(matchesAny("a/route.js", ["a/**/route.js"])).toBe(true);
  });

  it("matches ? as one non-slash character", () => {
    expect(matchesAny("v1.txt", ["v?.txt"])).toBe(true);
    expect(matchesAny("v10.txt", ["v?.txt"])).toBe(false);
    expect(matchesAny("v/.txt", ["v?.txt"])).toBe(false);
  });

  it("escapes regex characters in literal parts", () => {
    expect(matchesAny("app/projects/[slug]/page.jsx", ["app/projects/[slug]/*.jsx"])).toBe(true);
    expect(matchesAny("fileAjs", ["file.js"])).toBe(false);
  });
});

describe("outOfScope", () => {
  it("allows everything when no list is given", () => {
    expect(outOfScope(["anything.js"], null)).toEqual([]);
    expect(outOfScope(["anything.js"], [])).toEqual([]);
  });

  it("returns the paths that match no pattern", () => {
    expect(
      outOfScope(["components/InterviewDrill.jsx", "docs/log.md", "lib/projects.js"], ["components/InterviewDrill.jsx", "docs/**"])
    ).toEqual(["lib/projects.js"]);
  });
});
