import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  scaffoldRepo,
  formatScaffoldResult,
  ScaffoldError,
  type ScaffoldSpawn,
} from "../../src/init/scaffold.ts";
import { buildAgentsMd } from "../../src/init/agents_md.ts";
import { claudeSettingsJson } from "../../src/init/claude_settings.ts";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "prx-init-"));
  return root;
}

function spawnReturning(toplevel: string | null): ScaffoldSpawn {
  return (file, args) => {
    if (file === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      if (toplevel === null) {
        return { status: 128, stdout: "", stderr: "fatal: not a git repository\n" };
      }
      return { status: 0, stdout: `${toplevel}\n`, stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "" };
  };
}

describe("scaffoldRepo", () => {
  test("creates AGENTS.md and .claude/settings.json on a fresh repo", () => {
    const root = makeRepo();
    const result = scaffoldRepo({}, { cwd: root, spawn: spawnReturning(root) });

    expect(result.repoRoot).toBe(root);
    expect(result.files.map((f) => f.outcome)).toEqual(["created", "created"]);

    const agentsPath = join(root, "AGENTS.md");
    const settingsPath = join(root, ".claude", "settings.json");
    expect(readFileSync(agentsPath, "utf8")).toBe(buildAgentsMd());
    expect(readFileSync(settingsPath, "utf8")).toBe(claudeSettingsJson());
  });

  test("re-running is idempotent — both files report skipped", () => {
    const root = makeRepo();
    scaffoldRepo({}, { cwd: root, spawn: spawnReturning(root) });
    const second = scaffoldRepo({}, { cwd: root, spawn: spawnReturning(root) });

    expect(second.files.map((f) => f.outcome)).toEqual(["skipped", "skipped"]);
  });

  test("--force overwrites existing files", () => {
    const root = makeRepo();
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "stale\n");
    writeFileSync(join(root, ".claude", "settings.json"), "{}\n");

    const result = scaffoldRepo({ force: true }, { cwd: root, spawn: spawnReturning(root) });

    expect(result.files.map((f) => f.outcome)).toEqual(["forced", "forced"]);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(buildAgentsMd());
    expect(readFileSync(join(root, ".claude", "settings.json"), "utf8")).toBe(claudeSettingsJson());
  });

  test("selective scaffold — keeps existing settings.json, creates missing AGENTS.md", () => {
    const root = makeRepo();
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), '{ "existing": true }\n');

    const result = scaffoldRepo({}, { cwd: root, spawn: spawnReturning(root) });

    const outcomes = Object.fromEntries(result.files.map((f) => [f.path, f.outcome]));
    expect(outcomes[join(root, "AGENTS.md")]).toBe("created");
    expect(outcomes[join(root, ".claude", "settings.json")]).toBe("skipped");
    expect(readFileSync(join(root, ".claude", "settings.json"), "utf8")).toBe(
      '{ "existing": true }\n',
    );
  });

  test("throws ScaffoldError when not in a git repo", () => {
    const root = makeRepo();
    expect(() => scaffoldRepo({}, { cwd: root, spawn: spawnReturning(null) })).toThrow(
      ScaffoldError,
    );
  });

  test("rejects PATH_TYPE_CONFLICT when AGENTS.md exists as a directory", () => {
    const root = makeRepo();
    mkdirSync(join(root, "AGENTS.md"));

    let caught: unknown;
    try {
      scaffoldRepo({}, { cwd: root, spawn: spawnReturning(root) });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScaffoldError);
    expect((caught as ScaffoldError).code).toBe("PATH_TYPE_CONFLICT");
    expect((caught as ScaffoldError).message).toContain("AGENTS.md");
    expect((caught as ScaffoldError).message).toContain("directory");
  });

  test("rejects PATH_TYPE_CONFLICT when .claude exists as a file", () => {
    const root = makeRepo();
    writeFileSync(join(root, ".claude"), "not a directory\n");

    let caught: unknown;
    try {
      scaffoldRepo({}, { cwd: root, spawn: spawnReturning(root) });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScaffoldError);
    expect((caught as ScaffoldError).code).toBe("PATH_TYPE_CONFLICT");
    expect((caught as ScaffoldError).message).toContain(".claude");
    expect((caught as ScaffoldError).message).toContain("file");
  });

  test("rejects PATH_TYPE_CONFLICT when AGENTS.md is a symlink", () => {
    const root = makeRepo();
    writeFileSync(join(root, "elsewhere.md"), "stale\n");
    symlinkSync(join(root, "elsewhere.md"), join(root, "AGENTS.md"));

    let caught: unknown;
    try {
      scaffoldRepo({}, { cwd: root, spawn: spawnReturning(root) });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScaffoldError);
    expect((caught as ScaffoldError).code).toBe("PATH_TYPE_CONFLICT");
    expect((caught as ScaffoldError).message).toContain("symlink");
  });
});

describe("formatScaffoldResult", () => {
  test("plain output lists each file with outcome and the next-step pointer", () => {
    const out = formatScaffoldResult(
      {
        repoRoot: "/tmp/repo",
        files: [
          { path: "/tmp/repo/AGENTS.md", outcome: "created" },
          { path: "/tmp/repo/.claude/settings.json", outcome: "skipped" },
        ],
      },
      "plain",
    );
    expect(out).toContain("created /tmp/repo/AGENTS.md");
    expect(out).toContain("skipped /tmp/repo/.claude/settings.json");
    expect(out).toContain("Next: prx plan session GH-<n>");
  });

  test("json output is parseable and matches the input shape", () => {
    const result = {
      repoRoot: "/tmp/repo",
      files: [{ path: "/tmp/repo/AGENTS.md", outcome: "created" as const }],
    };
    const parsed = JSON.parse(formatScaffoldResult(result, "json"));
    expect(parsed).toEqual(result);
  });
});
