/**
 * gc `worktree` driver (GH-2331 / ai-home-q8h6y) — reclaims merged-leftover
 * worktrees.
 *
 * `mark()` reuses the prune classification: `buildParityChain({mode:"prune"})`
 * (scope=all) filtered to `delete_worktree` actions — the exact "PR merged +
 * issue closed but worktree still on disk" set. `sweep()` applies those removals
 * via `applyParityChainActions`. Deps are injected (mirrors `GcTeardownDeps`) so
 * this module never statically imports `pr-state/cli.ts` (ESM-cycle avoidance),
 * the same pattern the `runTeardown` path uses.
 *
 * Locked worktrees: lock state isn't on the board snapshot at mark time, so a
 * locked orphan surfaces as a candidate; the apply-time refusal in
 * `prx worktree-remove` comes back as a non-zero status → `failed` → `partial`.
 * This faithfully reproduces `prx prune` (which also refuses locked worktrees
 * at apply, not at planning).
 */

import type {
  SurfaceSyncAction,
  SurfaceSyncResult,
} from "@bounded-systems/surface-sync";

import { sweepableFromMark, type GcDriver, type GcMark } from "../capability.ts";
import type { GcFinding } from "../schema.ts";
import type { GcDriverDeps } from "./registry.ts";

type DeleteWorktreeAction = Extract<SurfaceSyncAction, { type: "delete_worktree" }>;

/** A `delete_worktree` action's reclaim key — ticket if known, else branch. */
function refOf(action: DeleteWorktreeAction): string {
  return action.ticket ?? action.branch;
}

function toFinding(action: DeleteWorktreeAction): GcFinding {
  return {
    component: "worktree",
    class: "orphan",
    ref: refOf(action),
    detail: action.reason,
  };
}

function deleteWorktreeActions(result: SurfaceSyncResult): DeleteWorktreeAction[] {
  return result.actions.filter(
    (a): a is DeleteWorktreeAction => a.type === "delete_worktree",
  );
}

export function createWorktreeDriver(deps: GcDriverDeps): GcDriver {
  return {
    component: "worktree",

    // Read-only discovery: never mutates (apply omitted ⇒ dry plan).
    async mark(): Promise<GcFinding[]> {
      const result = deps.buildParityChain(deps.repoPath, { mode: "prune" });
      return deleteWorktreeActions(result).map(toFinding);
    },

    async sweep(mark: GcMark, _ctx): Promise<{ reclaimed: GcFinding[]; failed?: string }> {
      // Phase-2 freshness: re-derive the live reclaimable set, then restrict to
      // the previously-marked set (TOCTOU guard) so a worktree that went active
      // between phases is never swept.
      const live = deps.buildParityChain(deps.repoPath, { mode: "prune", apply: true });
      const liveActions = deleteWorktreeActions(live);
      const sweepable = sweepableFromMark(mark, liveActions.map(toFinding));
      if (sweepable.length === 0) return { reclaimed: [] };

      if (!deps.applyParityChainActions) {
        return {
          reclaimed: [],
          failed: "gc worktree sweep requires the applyParityChainActions dependency",
        };
      }

      const sweepableRefs = new Set(sweepable.map((f) => f.ref));
      const actions = liveActions.filter((a) => sweepableRefs.has(refOf(a)));
      const filtered: SurfaceSyncResult = { ...live, actions };
      const results = deps.applyParityChainActions(filtered, deps.repoPath);

      const reclaimed: GcFinding[] = [];
      const failures: string[] = [];
      for (const r of results) {
        if (r.action.type !== "delete_worktree") continue;
        if (r.status === 0) {
          reclaimed.push(toFinding(r.action));
        } else {
          const why = (r.stderr ?? "").trim() || `exit ${r.status}`;
          failures.push(`${refOf(r.action)}: ${why}`);
        }
      }
      return failures.length > 0
        ? { reclaimed, failed: failures.join("; ") }
        : { reclaimed };
    },
  };
}
