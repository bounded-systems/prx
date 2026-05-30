/**
 * gc `tmux` driver (GH-2331 / tywg6) — reconciles drifted tmux server options
 * back to the rendered `tmux.conf` (`prx tmux reconcile`).
 *
 * `mark()` runs a dry reconcile → a `drift` finding per option whose live value
 * ≠ config (`would-apply` delta). `sweep()` re-derives the dry deltas (TOCTOU),
 * restricts to the marked set, then runs the real reconcile (`set-option`) →
 * options it actually set are `reclaimed`; failed deltas + server errors →
 * `failed`.
 *
 * Non-destructive (an idempotent `set-option`, not a delete) → `tmux` is NOT in
 * GC_DESTRUCTIVE_COMPONENTS, so `run --apply` reconciles it without a token. The
 * apply spans every current delta (a superset of the marked set), which is safe
 * for idempotent config sets — only the marked-and-applied options are counted
 * as reclaimed. No server (or no config) → the dry reconcile returns no deltas,
 * so mark is empty (clean). Deps (TmuxGcOps) are injected; without them the
 * driver no-ops (keeps the actor `run --all` tests hermetic).
 */

import type { TmuxAppliedDelta, TmuxReconcileResult } from "../../../pr-state/tmux-reconcile.ts";
import { sweepableFromMark, type GcDriver, type GcMark } from "../capability.ts";
import type { GcFinding } from "../schema.ts";
import type { GcDriverDeps } from "./registry.ts";

/** Drift finding ref: scope-qualified option name (e.g. `global:status-style`). */
function refOf(delta: Pick<TmuxAppliedDelta, "scope" | "option">): string {
  return `${delta.scope}:${delta.option}`;
}

function toFinding(delta: TmuxAppliedDelta): GcFinding {
  return {
    component: "tmux",
    class: "drift",
    ref: refOf(delta),
    detail: `${delta.from} -> ${delta.to}`,
  };
}

/** The would-apply deltas of a dry reconcile, as drift findings. */
function driftFindings(result: TmuxReconcileResult): GcFinding[] {
  return result.applied.filter((d) => d.status === "would-apply").map(toFinding);
}

export function createTmuxDriver(deps: GcDriverDeps): GcDriver {
  return {
    component: "tmux",

    // Read-only discovery: a dry reconcile never sets options.
    async mark(): Promise<GcFinding[]> {
      const ops = deps.tmux;
      if (!ops) return []; // no-op without injected tmux ops
      return driftFindings(ops.reconcile(true));
    },

    async sweep(mark: GcMark, _ctx): Promise<{ reclaimed: GcFinding[]; failed?: string }> {
      const ops = deps.tmux;
      if (!ops) return { reclaimed: [] };
      // Phase-2 freshness: re-derive the dry deltas, restrict to the marked set —
      // an option fixed out-of-band since mark is dropped from the accounting.
      const sweepable = sweepableFromMark(mark, driftFindings(ops.reconcile(true)));
      if (sweepable.length === 0) return { reclaimed: [] };

      // Apply (set-option is idempotent; the reconcile spans all current deltas,
      // a safe superset of the marked set). Count only marked-and-applied.
      const result = ops.reconcile(false);
      const markedRefs = new Set(sweepable.map((f) => f.ref));
      const appliedOk = new Set(
        result.applied.filter((d) => d.status === "applied").map((d) => refOf(d)),
      );
      const reclaimed = sweepable.filter((f) => appliedOk.has(f.ref));

      const failures: string[] = [];
      for (const d of result.applied) {
        if (d.status === "failed" && markedRefs.has(refOf(d))) {
          failures.push(`${refOf(d)}: ${(d.stderrTail ?? "").trim() || `exit ${d.exitCode ?? "?"}`}`);
        }
      }
      failures.push(...result.errors); // server-level errors (show-option, etc.)
      return failures.length > 0
        ? { reclaimed, failed: failures.join("; ") }
        : { reclaimed };
    },
  };
}
