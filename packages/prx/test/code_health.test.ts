// Code-health ratchet — the cheap, deterministic gate (the deep scan lives in
// `bun run health`). This is the "flag the monolith" rule bobby asked for: cap
// source-file size so no NEW monolith lands, and list the existing offenders as a
// paydown allowlist that only ever shrinks. When a file drops below the budget,
// remove it from MONOLITHS — the ratchet tightens, never loosens.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../src/repo-root.ts";
const REPO_ROOT = findRepoRoot();

const LINE_BUDGET = 2000;

// Known oversized files (the decomposition backlog — see docs/code-health.md).
// Shrink this set as files are split; never add to it without a deliberate call.
const MONOLITHS = new Set<string>([
  "packages/prx/src/pr-state/cli.ts", // 25.6k — the god file; decompose via the verb registry
  "packages/prx/src/pr-state/github.ts",
  "packages/prx/src/machine/runtime_profiles.ts",
  "packages/prx/src/cli/registry.data.ts",
  "packages/prx/src/pr-state/repos.ts",
]);

function trackedSrc(): string[] {
  const r = spawnSync("git", ["-C", REPO_ROOT, "ls-files", "packages/*/src/**/*.ts"], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").filter((f) => f && !f.endsWith(".test.ts"));
}

describe("code-health ratchet", () => {
  test(`no non-allowlisted source file exceeds ${LINE_BUDGET} lines`, () => {
    const offenders: string[] = [];
    for (const f of trackedSrc()) {
      if (MONOLITHS.has(f)) continue;
      const lines = readFileSync(join(REPO_ROOT, f), "utf8").split("\n").length;
      if (lines > LINE_BUDGET) offenders.push(`${f} (${lines})`);
    }
    expect(
      offenders,
      `new monolith(s) over ${LINE_BUDGET} lines — split them, or (deliberately) add to MONOLITHS`,
    ).toEqual([]);
  });

  test("MONOLITHS allowlist has no stale entries (each is still over budget)", () => {
    const stale: string[] = [];
    for (const f of MONOLITHS) {
      const lines = readFileSync(join(REPO_ROOT, f), "utf8").split("\n").length;
      if (lines <= LINE_BUDGET) stale.push(`${f} (${lines}) — now under budget, remove from MONOLITHS`);
    }
    expect(stale).toEqual([]);
  });
});
