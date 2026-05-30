// GH-1194 sub-ticket D — bounded scout grep verb. Tests use a tmpdir of
// fixture files so coverage is hermetic and stable across worktrees.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  formatScoutGrepJsonLines,
  runScoutGrep,
  ScoutGrepError,
} from "../grep.ts";

describe("runScoutGrep — bounded JS-side grep", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prx-scout-grep-"));
    // Fixture: two text files with a known marker, one binary-extension
    // file (skipped), one in a skip-dir (skipped).
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "ignored"), { recursive: true });
    writeFileSync(
      join(root, "src", "a.ts"),
      "import { x } from 'y';\nconst v = mkdtempSync('foo');\n",
    );
    writeFileSync(
      join(root, "src", "b.md"),
      "# heading\nuse mkdtemp here too\n\nanother line\n",
    );
    writeFileSync(
      join(root, "src", "c.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    writeFileSync(
      join(root, "node_modules", "ignored", "d.ts"),
      "// mkdtemp in skip-dir — must not appear\n",
    );
  });

  test("finds matches in src/ with line numbers and content", async () => {
    const result = await runScoutGrep({ pattern: "mkdtemp", in: root });
    expect(result.root).toBe(root);
    expect(result.matches.length).toBe(2);
    const paths = result.matches.map((m) => m.path).sort();
    expect(paths).toEqual(["src/a.ts", "src/b.md"]);
    const a = result.matches.find((m) => m.path === "src/a.ts");
    expect(a?.line).toBe(2);
    expect(a?.content).toContain("mkdtempSync");
  });

  test("skips binary extensions and skip-dirs", async () => {
    const result = await runScoutGrep({ pattern: "mkdtemp", in: root });
    expect(result.matches.every((m) => !m.path.startsWith("node_modules"))).toBe(true);
    expect(result.matches.every((m) => !m.path.endsWith(".png"))).toBe(true);
  });

  test("regex pattern works", async () => {
    const result = await runScoutGrep({
      pattern: "mkdtemp(Sync)?",
      in: root,
    });
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
  });

  test("invalid regex raises ScoutGrepError(INVALID_PATTERN)", async () => {
    let caught: unknown = null;
    try {
      await runScoutGrep({ pattern: "[unclosed", in: root });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutGrepError);
    expect((caught as ScoutGrepError).code).toBe("INVALID_PATTERN");
  });

  test("missing pattern raises ScoutGrepError(MISSING_PATTERN)", async () => {
    let caught: unknown = null;
    try {
      await runScoutGrep({ pattern: "", in: root });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutGrepError);
    expect((caught as ScoutGrepError).code).toBe("MISSING_PATTERN");
  });

  test("missing search root raises ScoutGrepError(ROOT_NOT_FOUND)", async () => {
    let caught: unknown = null;
    try {
      await runScoutGrep({ pattern: "x", in: join(root, "nonexistent") });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutGrepError);
    expect((caught as ScoutGrepError).code).toBe("ROOT_NOT_FOUND");
  });

  test("GH-<n> in --in raises explicit not-implemented", async () => {
    let caught: unknown = null;
    try {
      await runScoutGrep({ pattern: "x", in: "GH-1194" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutGrepError);
    expect((caught as ScoutGrepError).code).toBe(
      "WORKUNIT_RESOLUTION_NOT_IMPLEMENTED",
    );
  });

  test("maxResults bounds matches and sets truncated", async () => {
    // Add many matches to force truncation
    const many = Array.from({ length: 50 }, (_, i) => `mkdtemp_${i}`).join("\n");
    writeFileSync(join(root, "src", "many.ts"), many + "\n");
    const result = await runScoutGrep({
      pattern: "mkdtemp_",
      in: root,
      maxResults: 10,
    });
    expect(result.matches.length).toBe(10);
    expect(result.truncated).toBe(true);
  });

  test("pathPrefix filters matches by relative prefix", async () => {
    const result = await runScoutGrep({
      pattern: "mkdtemp",
      in: root,
      pathPrefix: "src/a",
    });
    expect(result.matches.map((m) => m.path)).toEqual(["src/a.ts"]);
  });

  test("formatScoutGrepJsonLines emits one match per line + trailing summary", async () => {
    const result = await runScoutGrep({ pattern: "mkdtemp", in: root });
    const text = formatScoutGrepJsonLines(result);
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(result.matches.length + 1);
    for (let i = 0; i < result.matches.length; i++) {
      const parsed = JSON.parse(lines[i] as string);
      expect(parsed.path).toBeDefined();
      expect(parsed.line).toBeDefined();
      expect(parsed.content).toBeDefined();
    }
    const summary = JSON.parse(lines[lines.length - 1] as string);
    expect(summary._summary.matches).toBe(result.matches.length);
    expect(summary._summary.pattern).toBe("mkdtemp");
  });
});
