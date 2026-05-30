/**
 * gc `hooks` driver (GH-2331 / tywg6) — reconciles git `core.hooksPath` drift
 * across the local repo inventory back to the managed hooks dir.
 *
 * `mark()` runs `hookStatus` (read-only) and emits a `drift` finding per repo
 * whose `core.hooksPath` ≠ the expected path. `sweep()` re-derives the drift
 * (TOCTOU), restricts to the previously-marked set, then `applyHooks` writes the
 * expected path to exactly those repos — the ones it actually changed are
 * `reclaimed`; per-repo errors → `failed`.
 *
 * Non-destructive (a git-config rewrite, not a delete), so `hooks` is NOT in
 * GC_DESTRUCTIVE_COMPONENTS — `run --apply` sweeps it without a capability token.
 * Deps (HooksGcOps) are injected; without them the driver no-ops (keeps the
 * actor `run --all` tests hermetic). The inventory + expected-path are resolved
 * lazily so a non-hooks gc run never walks the repo filesystem.
 *
 * The FIRST reshape driver: it establishes the injected-verb-fn pattern the
 * remaining reshape drivers copy (mirrors `worktree`/`cas`, but wraps a verb's
 * discover/apply fns rather than the prune chain or the CAS ops).
 */

import { sweepableFromMark, type GcDriver, type GcMark } from "../capability.ts";
import type { GcFinding } from "../schema.ts";
import type { GcDriverDeps } from "./registry.ts";

/** A hooks-drift finding: ref = repo name, class = drift, detail = current→expected. */
function toFinding(repoName: string, current: string | null, expected: string): GcFinding {
  return {
    component: "hooks",
    class: "drift",
    ref: repoName,
    detail: `${current ?? "<unset>"} -> ${expected}`,
  };
}

export function createHooksDriver(deps: GcDriverDeps): GcDriver {
  return {
    component: "hooks",

    // Read-only discovery: `hookStatus` never mutates git config.
    async mark(): Promise<GcFinding[]> {
      const ops = deps.hooks;
      if (!ops) return []; // no-op without injected hooks ops
      const { inventory, expectedPath } = ops.resolve();
      return ops
        .status(inventory, expectedPath)
        .repos.filter((r) => !r.matches)
        .map((r) => toFinding(r.name, r.currentHooksPath, expectedPath));
    },

    async sweep(mark: GcMark, _ctx): Promise<{ reclaimed: GcFinding[]; failed?: string }> {
      const ops = deps.hooks;
      if (!ops) return { reclaimed: [] };
      // Phase-2 freshness: re-derive drift now, restrict to the marked set — a
      // repo whose hooksPath was fixed out-of-band since mark is dropped.
      const { inventory, expectedPath } = ops.resolve();
      const liveDrift = ops
        .status(inventory, expectedPath)
        .repos.filter((r) => !r.matches)
        .map((r) => toFinding(r.name, r.currentHooksPath, expectedPath));
      const sweepable = sweepableFromMark(mark, liveDrift);
      if (sweepable.length === 0) return { reclaimed: [] };

      // Restrict the apply to exactly the marked-and-still-drifted repos (the
      // two-phase contract: sweep acts only on the marked set).
      const sweepableRefs = new Set(sweepable.map((f) => f.ref));
      const scoped = { ...inventory, repos: inventory.repos.filter((r) => sweepableRefs.has(r.name)) };
      const result = ops.apply(scoped, expectedPath);

      const reclaimed: GcFinding[] = [];
      const failures: string[] = [];
      for (const repo of result.repos) {
        if (repo.error) {
          failures.push(`${repo.name}: ${repo.error}`);
        } else if (repo.changed) {
          reclaimed.push(toFinding(repo.name, repo.previousHooksPath, expectedPath));
        }
        // changed:false + no error = already at expected (raced); not reclaimed, not failed.
      }
      return failures.length > 0
        ? { reclaimed, failed: failures.join("; ") }
        : { reclaimed };
    },
  };
}
