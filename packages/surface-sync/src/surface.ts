/**
 * Issue-parity ontology — surface axis (GH-1966).
 *
 * The state surfaces an issue-parity reconciliation reads for a work
 * unit, plus the subset that can carry authority. Pure data types,
 * relocated verbatim from `src/pr-state/github.ts` (documentary layer;
 * no runtime values live here).
 */

export type SurfaceSyncFeature = "gh_issue" | "beads_issue" | "project_item" | "merge_state" | "ci";

// GH-2092: direction of bd↔gh issue-parity reconciliation. Names the
// side(s) read authoritatively. Additive; not yet consumed at runtime.
export type SurfaceSyncDirection = "bd_to_gh" | "gh_to_bd" | "both";

export type SurfaceSyncAuthorityFeature = Extract<SurfaceSyncFeature, "gh_issue" | "beads_issue">;
