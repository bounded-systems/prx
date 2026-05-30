/**
 * Issue-parity ontology — plan dimensions (GH-1966).
 *
 * The mode/scope/authority axes that parameterize a reconciliation
 * plan. Pure data types, relocated verbatim from
 * `src/pr-state/github.ts`.
 */

export type SurfaceSyncMode = "prune" | "backfill" | "full";
export type SurfaceSyncScope = "local" | "remote" | "all";
export type SurfaceSyncAuthority = "issue" | "pr" | "local";
