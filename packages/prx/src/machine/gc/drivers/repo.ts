/**
 * gc `repo` driver (GH-2331 / tywg6) — reclaims embedded-dolt migration orphans
 * (`prx repo gc`): leftover `embeddeddolt/<db>/` dirs in mainx worktrees after a
 * repo moved to the shared dolt server.
 *
 * `mark()` runs a dry `runRepoGc` → an `orphan` finding per `would-sweep` entry
 * (ref = the orphan path, `reclaim_bytes` = its footprint). `sweep()` re-derives
 * the dry plan (TOCTOU), restricts to the marked set, then runs the real
 * `runRepoGc` (`rm -rf`) → entries it actually swept are `reclaimed`; an entry
 * that comes back `refused` (a precondition regressed) → `failed`.
 *
 * Destructive (`rm -rf`) → `repo` is in GC_DESTRUCTIVE_COMPONENTS, so
 * `run --apply` needs the `gc:delete` token; the driver passes `yes:true` (the
 * gc capability token IS the confirmation — no interactive prompt). The actual
 * delete is guarded per-entry inside `runRepoGc`, which re-checks the migration
 * preconditions at apply time and `refused`s anything no longer safe — that is
 * the load-bearing TOCTOU guard for the `rm`. Deps (RepoGcOps) are injected;
 * without them the driver no-ops.
 */

import type { RepoGcEntry, RepoGcReport } from "../../../pr-state/repo_gc.ts";
import { sweepableFromMark, type GcDriver, type GcMark } from "../capability.ts";
import type { GcFinding } from "../schema.ts";
import type { GcDriverDeps } from "./registry.ts";

/** A would-sweep/swept entry as an orphan finding (ref = the orphan dir). */
function toFinding(entry: RepoGcEntry): GcFinding {
  return {
    component: "repo",
    class: "orphan",
    ref: entry.orphanPath ?? entry.workspacePath,
    detail: `${entry.slug} (${entry.classification})`,
    ...(entry.orphanBytes != null ? { reclaim_bytes: entry.orphanBytes } : {}),
  };
}

/** The reclaimable orphans of a report: `would-sweep` entries with a real path. */
function reclaimable(report: RepoGcReport): GcFinding[] {
  return report.entries
    .filter((e) => e.action === "would-sweep" && e.orphanPath)
    .map(toFinding);
}

export function createRepoDriver(deps: GcDriverDeps): GcDriver {
  return {
    component: "repo",

    // Read-only discovery: a dry runRepoGc classifies + sizes, never rm's.
    async mark(): Promise<GcFinding[]> {
      const ops = deps.repo;
      if (!ops) return []; // no-op without injected repo-gc ops
      return reclaimable(ops.run(false));
    },

    async sweep(mark: GcMark, _ctx): Promise<{ reclaimed: GcFinding[]; failed?: string }> {
      const ops = deps.repo;
      if (!ops) return { reclaimed: [] };
      // Phase-2 freshness: re-derive the would-sweep set, restrict to the marked
      // set — an orphan whose preconditions regressed since mark is dropped here
      // (and would be `refused` by runRepoGc's own apply-time re-check anyway).
      const sweepable = sweepableFromMark(mark, reclaimable(ops.run(false)));
      if (sweepable.length === 0) return { reclaimed: [] };

      // Apply: runRepoGc re-checks the migration preconditions per entry and
      // `rm`s only the still-safe orphans (the load-bearing delete guard).
      const report = ops.run(true);
      const markedRefs = new Set(sweepable.map((f) => f.ref));
      const reclaimed: GcFinding[] = [];
      const failures: string[] = [];
      for (const e of report.entries) {
        const ref = e.orphanPath ?? e.workspacePath;
        if (!markedRefs.has(ref)) continue;
        if (e.action === "swept") {
          reclaimed.push(toFinding(e));
        } else if (e.action === "refused") {
          failures.push(`${ref}: refused (${e.refusalReason ?? "precondition"})`);
        }
      }
      return failures.length > 0
        ? { reclaimed, failed: failures.join("; ") }
        : { reclaimed };
    },
  };
}
