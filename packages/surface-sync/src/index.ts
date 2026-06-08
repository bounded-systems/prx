/**
 * Surface-sync type ontology.
 *
 * The type surface for change-detection + syncing a unit of work across its
 * surfaces (GH issue ↔ branch ↔ worktree ↔ beads). Mostly the
 * type surface plus the pure output formatter; the board reader (boardStatus)
 * and the plan builders (buildSurfaceSyncFromBoard, …) still live in
 * `src/pr-state/github.ts` pending shared-infrastructure decoupling (see
 * `docs/architecture/surface-sync-extraction.md`).
 *
 * A distinct concept from the anchored-chain provenance module; historically
 * bundled under `parity-chain/`, now its own module.
 * `verbatimModuleSyntax` requires the type-only re-exports below.
 *
 * Axes: surface → config → scope/mode/authority → action → result.
 */

export type {
  SurfaceSyncDirection,
  SurfaceSyncFeature,
  SurfaceSyncAuthorityFeature,
} from "./surface.ts";

export type { SurfaceSyncConfig } from "./config.ts";

export type {
  SurfaceSyncAuthority,
  SurfaceSyncMode,
  SurfaceSyncScope,
} from "./scope.ts";

export type { SurfaceSyncAction } from "./action.ts";

export type { SurfaceSyncResult } from "./result.ts";

export { formatSurfaceSync } from "./format.ts";

export type { BoardSnapshot, BoardSnapshotUnit } from "./snapshot.ts";

export type { PrefixRoutingConfig } from "./routing.ts";
export { resolveFeatureForPrefix } from "./routing.ts";

export {
  issueParityFeatureEnabled,
  issueFeatureForUnit,
  issueFeatureStatus,
  normalizeIssueStatus,
  githubIssueNumberFromWorkUnitId,
} from "./board-helpers.ts";

export { computeSurfaceSync } from "./transform.ts";
