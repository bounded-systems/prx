// GH-1423 PR-1: assertion contract tests.
//
// The load-bearing test in this file is "core.md:96 drift case raises a
// `RULES_ASSERTION_FAILED` with rule='alias-exists'". That's the spike
// thesis — the validator catches the `za` / `zb` / `zc` drift the
// operator's eye missed. Until alias-supply is wired (follow-up
// GH-1423/follow-up/alias-supply), this is *expected* to fail-by-design
// when run against the live `core.md`; the test asserts the failure has
// the right shape.

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { loadVerbSupply } from "../../src/rules/loaders/verb-supply.ts";
import {
  aliasExists,
  verbExists,
  worktreeGestureResolves,
} from "../../src/rules/validate/assertions.ts";

describe("aliasExists — fence gating", () => {
  test("returns no failures when no alias fences are present", () => {
    const md = "## A heading\n\nNo fences here. `za` should not be checked.\n";
    expect(aliasExists(md, "test.md", [])).toEqual([]);
  });

  test("flags every backticked token inside an alias fence when supply is empty", () => {
    const md = [
      "Some prose",
      "<!-- assert:alias -->",
      "Use `za`, `zb`, `zc` for switching.",
      "<!-- /assert:alias -->",
      "More prose `outside` the fence.",
    ].join("\n");
    const failures = aliasExists(md, "core.md", []);
    expect(failures.length).toBeGreaterThanOrEqual(3);
    for (const f of failures) {
      expect(f.rule).toBe("alias-exists");
      expect(f.file).toBe("core.md");
    }
    const subjects = failures.map((f) => f.subject);
    expect(subjects).toContain("za");
    expect(subjects).toContain("zb");
    expect(subjects).toContain("zc");
  });

  test("known aliases inside the fence do not fail", () => {
    const md = [
      "<!-- assert:alias -->",
      "Use `za` for switching.",
      "<!-- /assert:alias -->",
    ].join("\n");
    const failures = aliasExists(md, "core.md", [
      { name: "za", target: "wt switch a", source: "nix" },
    ]);
    expect(failures).toEqual([]);
  });
});

describe("worktreeGestureResolves — fence gating", () => {
  test("flags unknown gestures inside the gesture fence", () => {
    const md = [
      "<!-- assert:worktree-gesture -->",
      "The `swap` gesture switches worktrees.",
      "<!-- /assert:worktree-gesture -->",
    ].join("\n");
    const failures = worktreeGestureResolves(md, "core.md", []);
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures[0]!.rule).toBe("worktree-gesture-resolves");
  });
});

describe("verbExists — unfenced", () => {
  test("registered prx verbs pass", () => {
    const supply = loadVerbSupply();
    const md = "Run `prx plan session` to start.\n";
    expect(verbExists(md, "core.md", supply)).toEqual([]);
  });

  test("non-prx allowlisted tokens are not flagged", () => {
    const supply = loadVerbSupply();
    const md = "Run `bd ready` or `gh pr list`.\n";
    expect(verbExists(md, "core.md", supply)).toEqual([]);
  });

  test("unknown prx verb fails the assertion", () => {
    const supply = loadVerbSupply();
    const md = "Run `prx does-not-exist` to break.\n";
    const failures = verbExists(md, "core.md", supply);
    expect(failures.length).toBe(1);
    expect(failures[0]!.rule).toBe("verb-exists");
    expect(failures[0]!.subject).toContain("prx does-not-exist");
  });

  test("tokens inside `<!-- assert:none -->` fences are skipped", () => {
    const supply = loadVerbSupply();
    const md = [
      "<!-- assert:none -->",
      "Run `prx does-not-exist` (illustrative).",
      "<!-- /assert:none -->",
    ].join("\n");
    expect(verbExists(md, "core.md", supply)).toEqual([]);
  });
});

// Reads ai-home's claude/rules/core.md, which is absent in the prx repo — skip there.
describe.skipIf(!existsSync("claude/rules/core.md"))("spike thesis — claude/rules/core.md:95 drift case", () => {
  test("aliasExists raises a typed failure for the za/zb/zc line", () => {
    const corePath = "claude/rules/core.md";
    const fullMarkdown = readFileSync(corePath, "utf8");
    const lines = fullMarkdown.split("\n");
    // GH-2011: line shifted from 96 to 95 when the retired `bd github sync`
    // session-close protocol block was stripped.
    const targetLine = lines[94] ?? "";

    // Confirm the drift line is the one the design doc cites.
    expect(targetLine).toContain("`za`");
    expect(targetLine).toContain("`zb`");
    expect(targetLine).toContain("`zc`");

    // Synthesize the markdown a future renderer will produce: wrap the
    // exact drift line in an alias fence. Pad with empty lines so the
    // failure's `line` matches the citation in the design doc (95).
    const synthesized: string[] = [];
    for (let i = 0; i < 93; i++) synthesized.push("");
    synthesized.push("<!-- assert:alias -->");
    synthesized.push(targetLine);
    synthesized.push("<!-- /assert:alias -->");
    const md = synthesized.join("\n");

    const failures = aliasExists(md, corePath, []);
    // The line carries three alias tokens; each should fail.
    expect(failures.length).toBeGreaterThanOrEqual(3);

    const lineNumbers = new Set(failures.map((f) => f.line));
    expect(lineNumbers.has(95)).toBe(true);

    const onTargetLine = failures.filter((f) => f.line === 95);
    expect(onTargetLine.length).toBeGreaterThanOrEqual(3);
    for (const f of onTargetLine) {
      expect(f.rule).toBe("alias-exists");
      expect(f.file).toBe(corePath);
    }
    const subjects = new Set(onTargetLine.map((f) => f.subject));
    expect(subjects.has("za")).toBe(true);
    expect(subjects.has("zb")).toBe(true);
    expect(subjects.has("zc")).toBe(true);
  });
});
