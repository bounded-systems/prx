/**
 * Surface-sync ontology — result axis.
 *
 * The computed reconciliation plan: per-unit actions plus the
 * mode/authority/scope it was computed under.
 *
 * The `Disposition` reference is the single documented boundary from the
 * surface-sync module back into `src/pr-state/`. Abstracting it away is a
 * follow-up.
 */

import type { Disposition } from "@bounded-systems/disposition";

import type { SurfaceSyncAction } from "./action.ts";
import type { SurfaceSyncAuthority, SurfaceSyncMode, SurfaceSyncScope } from "./scope.ts";

export type SurfaceSyncResult = {
  source: "surface-sync";
  repo: string;
  mode: SurfaceSyncMode;
  authority: SurfaceSyncAuthority;
  scope: SurfaceSyncScope;
  apply: boolean;
  ticket?: string;
  units: Array<{
    branch: string;
    ticket: string | null;
    actions: SurfaceSyncAction[];
    disposition?: Disposition;
    /**
     * GH-2147: operator-facing reasons this unit was NOT auto-reconciled
     * (e.g. a completed unit whose worktree is dirty). Present so prune
     * never silently no-ops on a live worktree;
     * surfaced by `formatSurfaceSync` even when the unit emits zero actions.
     */
    blockers?: string[];
  }>;
  actions: SurfaceSyncAction[];
};
