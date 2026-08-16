/**
 * gc `chain` driver (GH-2331 / tywg6) — reclaims orphaned parity-chain BRANCH
 * leaves: the local/remote branches of units whose PR merged + issue closed
 * (`prx chain prune`). Complement of the `worktree` driver — same prune plan
 * (`buildParityChain({mode:"prune"})`), filtered to the branch actions instead
 * of `delete_worktree`. Together `chain` + `worktree` are the batch equivalent
 * of running `prx prune` across every completed unit.
 *
 * Destructive (deletes branches, incl. the REMOTE branch) → `chain` is in
 * GC_DESTRUCTIVE_COMPONENTS, so `run --apply` needs the `gc:delete` token.
 *
 * Reuses the injected `buildParityChain`/`applyParityChainActions` already on
 * `GcDriverDeps` — no new deps. mark/sweep mirror the `worktree` driver; deps
 * are injected so this module never statically imports `pr-state/cli.ts`.
 *
 * Ordering guard: a `delete_local_branch` fails while the unit's worktree is
 * still checked out, and on `run --all` `chain` (enum idx 0) runs BEFORE
 * `worktree`. So a local branch whose unit still has a `delete_worktree` action
 * in the SAME plan is DEFERRED — the worktree driver removes the worktree this
 * run, and the local branch reappears in the next plan (no live worktree) and is
 * reclaimed then. Remote-branch deletes have no such dependency and are always
 * eligible. A local delete that still fails at apply (a worktree we didn't see)
 * surfaces as `partial`, exactly as the worktree driver handles a locked one.
 */

import type { SurfaceSyncAction, SurfaceSyncResult } from "@bounded-systems/surface-sync";

import { sweepableFromMark, type GcDriver, type GcMark } from "../capability.ts";
import type { GcFinding } from "../schema.ts";
import type { GcDriverDeps } from "./registry.ts";

type BranchAction = Extract<
  SurfaceSyncAction,
  { type: "delete_local_branch" | "delete_remote_branch" }
>;

/** A unit's reclaim key — ticket if known, else branch (matches across the
 * delete_worktree / delete_local_branch actions of the same unit). */
function unitKey(action: { ticket?: string | null; branch: string }): string {
  return action.ticket ?? action.branch;
}

/** Finding ref: scope-qualified so a unit's local + remote deletes are distinct
 * findings (and don't collide in `sweepableFromMark`). */
function refOf(action: BranchAction): string {
  const scope = action.type === "delete_remote_branch" ? "remote" : "local";
  return `${scope}:${action.branch}`;
}

function toFinding(action: BranchAction): GcFinding {
  return {
    component: "chain",
    class: "orphan",
    ref: refOf(action),
    detail: action.reason,
  };
}

/**
 * Branch actions eligible THIS pass: every remote-branch delete, plus
 * local-branch deletes whose unit has no live worktree in the plan (see the
 * ordering guard in the file header).
 */
function eligibleBranchActions(result: SurfaceSyncResult): BranchAction[] {
  const liveWorktreeUnits = new Set(
    result.actions
      .filter((a) => a.type === "delete_worktree")
      .map((a) => unitKey(a as Extract<SurfaceSyncAction, { type: "delete_worktree" }>)),
  );
  return result.actions.filter((a): a is BranchAction => {
    if (a.type === "delete_remote_branch") return true;
    if (a.type === "delete_local_branch") return !liveWorktreeUnits.has(unitKey(a));
    return false;
  });
}

export function createChainDriver(deps: GcDriverDeps): GcDriver {
  return {
    component: "chain",

    // Read-only discovery: never mutates (apply omitted ⇒ dry plan).
    async mark(): Promise<GcFinding[]> {
      const result = deps.buildParityChain(deps.repoPath, { mode: "prune" });
      return eligibleBranchActions(result).map(toFinding);
    },

    async sweep(mark: GcMark, _ctx): Promise<{ reclaimed: GcFinding[]; failed?: string }> {
      // Phase-2 freshness: re-derive the live plan, then restrict to the marked
      // set (TOCTOU guard) so a branch that came back to life between phases is
      // never deleted.
      const live = deps.buildParityChain(deps.repoPath, { mode: "prune", apply: true });
      const liveActions = eligibleBranchActions(live);
      const sweepable = sweepableFromMark(mark, liveActions.map(toFinding));
      if (sweepable.length === 0) return { reclaimed: [] };

      if (!deps.applyParityChainActions) {
        return {
          reclaimed: [],
          failed: "gc chain sweep requires the applyParityChainActions dependency",
        };
      }

      const sweepableRefs = new Set(sweepable.map((f) => f.ref));
      const actions = liveActions.filter((a) => sweepableRefs.has(refOf(a)));
      const filtered: SurfaceSyncResult = { ...live, actions };
      const results = deps.applyParityChainActions(filtered, deps.repoPath);

      const reclaimed: GcFinding[] = [];
      const failures: string[] = [];
      for (const r of results) {
        if (r.action.type !== "delete_local_branch" && r.action.type !== "delete_remote_branch") {
          continue;
        }
        const action = r.action as BranchAction;
        if (r.status === 0) {
          reclaimed.push(toFinding(action));
        } else {
          const why = (r.stderr ?? "").trim() || `exit ${r.status}`;
          failures.push(`${refOf(action)}: ${why}`);
        }
      }
      return failures.length > 0 ? { reclaimed, failed: failures.join("; ") } : { reclaimed };
    },
  };
}
