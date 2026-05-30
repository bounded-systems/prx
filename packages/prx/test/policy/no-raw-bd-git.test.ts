// GH-1990 / GH-2011 — `prx beads sync` actor as the only sanctioned path.
//
// Forward-guard against re-introducing raw `bd github sync --pull-only
// --prefer-github` instructional prose in scope-cleaned files.
//
// GH-2011 retired the destructive shell-out from prx production code paths
// the operator most frequently exercises (the GhDomainAdapter close-apply,
// `prx beads sync --domain=gh`, the post-write triage chain, `plan close`,
// and `sync-issues-pair`). GH-2316 completed the migration: the remaining
// triage write verbs (prioritize, prioritize-bulk, drift-fix,
// migrate-axis-value, and the prune-merged pre-step) now chain the
// status-only `runBeadsSync` too, so a GH `priority::*` label can no longer
// round-trip into bd-canonical priority (invariant I-DS-PRIO). Those files
// are added to the guarded list below so a regression that re-introduces the
// literal phrase is caught at CI time.
//
// The canonical operator/agent surface is `prx sync issues --from gh --to bd`
// (which now delegates to `runBeadsSync` underneath). New code and prose
// that need to refer to the reconcile path must name the canonical verb.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const GUARDED_FILES = [
  "../../README.md",
  "src/triage/drift-fix.ts",
  "src/triage/apply.ts",
  // GH-2011 — scope-cleaned files (added to the guard so a regression that
  // re-introduces the literal phrase is caught at CI time).
  "src/triage/type-pass.ts",
  "src/adapters/github.ts",
  "src/sync/run.ts",
  "src/pr-state/github.ts",
  "src/pr-state/cli.ts",
  // GH-2316 — remaining triage write verbs migrated off the destructive
  // shell-out onto the status-only `runBeadsSync` (closes the priority
  // round-trip channel; invariant I-DS-PRIO).
  "src/triage/prioritize.ts",
  "src/triage/prioritize-bulk.ts",
  "src/triage/migrate-axis-value.ts",
  "src/triage/prune-merged.ts",
  "src/triage/issues-from-beads.ts",
] as const;

// The scrubbed instructional phrase. Any reintroduction in a guarded file is
// a regression. Single literal — no regex tricks; the canonical verb
// (`prx sync issues --from gh --to bd`) is what new prose must use.
const FORBIDDEN_PHRASE = "bd github sync --pull-only --prefer-github";

describe("GH-1990 / GH-2011 — no raw bd github sync --pull-only --prefer-github in canonicalized surfaces", () => {
  for (const relPath of GUARDED_FILES) {
    it(`${relPath} names prx sync issues, not the raw bd verb`, () => {
      const contents = readFileSync(join(REPO_ROOT, relPath), "utf8");
      const lines = contents.split("\n");
      const hits: { line: number; text: string }[] = [];
      lines.forEach((text, idx) => {
        if (text.includes(FORBIDDEN_PHRASE)) {
          hits.push({ line: idx + 1, text: text.trim() });
        }
      });
      if (hits.length > 0) {
        const formatted = hits
          .map(({ line, text }) => `  ${relPath}:${line}  ${text}`)
          .join("\n");
        throw new Error(
          `Found raw \`${FORBIDDEN_PHRASE}\` instruction(s) in ${relPath}.\n` +
            `Use the canonical \`prx sync issues --from gh --to bd\` instead.\n` +
            `Offending line(s):\n${formatted}`,
        );
      }
      expect(hits.length).toBe(0);
    });
  }
});
