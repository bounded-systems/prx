/**
 * Issue-parity ontology — config axis (GH-1966).
 *
 * Policy over the surface axis: which surfaces are enabled for
 * reconciliation. Pure data type, relocated verbatim from
 * `src/pr-state/github.ts`.
 */

import type { SurfaceSyncFeature } from "./surface.ts";

export type SurfaceSyncConfig = {
  features: Record<SurfaceSyncFeature, boolean>;
};
