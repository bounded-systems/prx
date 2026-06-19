// GH-1384 PR-1 — bounded scout files (glob) verb. Tests use a tmpdir of
// fixture files so coverage is hermetic and stable across worktrees.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { formatScoutFilesJsonLines, runScoutFiles, ScoutFilesError } from "../files.ts";

describe("runScoutFiles — bounded glob walk", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prx-scout-files-"));
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    mkdirSync(join(root, "node_modules", "ignored"), { recursive: true });
    writeFileSync(join(root, "flake.nix"), "{}\n");
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "b.nix"), "{}\n");
    writeFileSync(join(root, "src", "nested", "c.nix"), "{}\n");
    writeFileSync(join(root, "node_modules", "ignored", "d.nix"), "must not appear\n");
  });

  test("matches `**/*.nix` across nested dirs and the root", async () => {
    const result = await runScoutFiles({ pattern: "**/*.nix", in: root });
    expect(result.root).toBe(root);
    const paths = result.matches.map((m) => m.path).sort();
    expect(paths).toEqual(["flake.nix", "src/b.nix", "src/nested/c.nix"]);
  });

  test("skips skip-dirs", async () => {
    const result = await runScoutFiles({ pattern: "**/*.nix", in: root });
    expect(result.matches.every((m) => !m.path.startsWith("node_modules"))).toBe(true);
  });

  test("single-segment glob does not cross directories", async () => {
    const result = await runScoutFiles({ pattern: "*.nix", in: root });
    expect(result.matches.map((m) => m.path)).toEqual(["flake.nix"]);
  });

  test("literal pattern matches an exact relative path", async () => {
    const result = await runScoutFiles({ pattern: "src/a.ts", in: root });
    expect(result.matches.map((m) => m.path)).toEqual(["src/a.ts"]);
  });

  test("missing pattern raises ScoutFilesError(MISSING_PATTERN)", async () => {
    let caught: unknown = null;
    try {
      await runScoutFiles({ pattern: "", in: root });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutFilesError);
    expect((caught as ScoutFilesError).code).toBe("MISSING_PATTERN");
  });

  test("missing search root raises ScoutFilesError(ROOT_NOT_FOUND)", async () => {
    let caught: unknown = null;
    try {
      await runScoutFiles({ pattern: "**/*.nix", in: join(root, "nonexistent") });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutFilesError);
    expect((caught as ScoutFilesError).code).toBe("ROOT_NOT_FOUND");
  });

  test("GH-<n> in --in raises explicit not-implemented", async () => {
    let caught: unknown = null;
    try {
      await runScoutFiles({ pattern: "**/*.ts", in: "GH-1194" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutFilesError);
    expect((caught as ScoutFilesError).code).toBe("WORKUNIT_RESOLUTION_NOT_IMPLEMENTED");
  });

  test("maxResults bounds matches and sets truncated", async () => {
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(root, "src", `gen_${i}.ts`), "export {};\n");
    }
    const result = await runScoutFiles({
      pattern: "src/gen_*.ts",
      in: root,
      maxResults: 10,
    });
    expect(result.matches.length).toBe(10);
    expect(result.truncated).toBe(true);
  });

  test("formatScoutFilesJsonLines emits one match per line + trailing summary", async () => {
    const result = await runScoutFiles({ pattern: "**/*.nix", in: root });
    const text = formatScoutFilesJsonLines(result);
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(result.matches.length + 1);
    for (let i = 0; i < result.matches.length; i++) {
      const parsed = JSON.parse(lines[i] as string);
      expect(parsed.path).toBeDefined();
    }
    const summary = JSON.parse(lines[lines.length - 1] as string);
    expect(summary._summary.matches).toBe(result.matches.length);
    expect(summary._summary.pattern).toBe("**/*.nix");
  });
});
