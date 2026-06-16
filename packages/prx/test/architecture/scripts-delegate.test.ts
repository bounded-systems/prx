// Scripts → prx verbs — the forcing function for the convergence in
// docs/code-health.md §4: every `scripts/*.ts` must DELEGATE to prx's library
// (import from `../src/`) rather than carry standalone logic. A script that
// reuses `src/` is a thin wrapper around code that is (or can become) a spec-
// driven verb — `prx <verb>` and `bun run <script>` then share one
// implementation and can't drift. A self-contained "script-only" file is the
// anti-pattern this guard blocks.
//
// SCRIPT_BASELINE pins the scripts that are still standalone today — build/infra
// tooling that legitimately owns its logic (the binary compiler, coverage
// format shims, smoke tests, one-offs). The guard fails if a NEW script lands
// without delegating, or if a baselined script starts delegating without being
// removed here — so the list only shrinks, toward an empty hard guarantee.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts");

// Standalone scripts that own their logic today (not yet — or never — delegating
// to `src/`). Each is build/infra tooling, not product logic. Only removals.
const SCRIPT_BASELINE = new Set<string>([
  "audit_sample.ts",
  "codeql-quality.ts",
  "coverage-summary.ts",
  "jsr-sync.ts",
  "lcov-to-cobertura.ts",
  "prx-compile.ts",
  "rebrand.ts",
  "smoke-release.ts",
]);

/** A script delegates to the prx library iff it imports from `../src/`. */
function delegatesToSrc(file: string): boolean {
  return /from\s+["']\.\.\/src\//.test(readFileSync(join(SCRIPTS_DIR, file), "utf8"));
}

function scriptFiles(): string[] {
  return readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
}

describe("scripts delegate to prx (scripts → verbs forcing function)", () => {
  test("no NEW script is self-contained — it must import from ../src/ or be baselined", () => {
    const offenders = scriptFiles()
      .filter((f) => !delegatesToSrc(f) && !SCRIPT_BASELINE.has(f))
      .sort();
    expect(
      offenders,
      "these scripts carry standalone logic — delegate to a src/ module (ideally a prx verb), " +
        "or, if they are genuinely prx-owned build/infra tooling, add them to SCRIPT_BASELINE",
    ).toEqual([]);
  });

  test("SCRIPT_BASELINE has no stale entries — remove a script once it delegates to ../src/", () => {
    const present = new Set(scriptFiles());
    const stale = [...SCRIPT_BASELINE]
      .filter((f) => !present.has(f) || delegatesToSrc(f))
      .sort();
    expect(stale, "remove these from SCRIPT_BASELINE — they now delegate (or no longer exist)").toEqual([]);
  });
});
