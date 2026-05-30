/**
 * Prefix routing — maps a branch / work-unit id to the issue-authority feature
 * that governs it (`gh_issue` | `beads_issue`). Pure; self-contained.
 *
 * Part of surface-sync because routing is a surface-sync concern (which surface
 * holds authority for a unit). The config loader (`loadPrefixRoutingConfig`,
 * IO) stays on the github side and re-imports `PrefixRoutingConfig` from here.
 */

import type { SurfaceSyncAuthorityFeature } from "./surface.ts";

export type PrefixRoutingConfig = {
  features: Record<string, SurfaceSyncAuthorityFeature>;
};

const ROUTING_PREFIX_RE = /^([A-Z][A-Z0-9]+)-\d+$/;
const BD_SHORT_SURFACE_RE = /^BD-[0-9A-F]{8}$/i;
const BD_LONG_SURFACE_RE = /^BD-[A-Z][A-Z0-9-]*-\d{13,}-\d+-[0-9A-F]{8}$/i;

export function resolveFeatureForPrefix(
  branchOrWorkUnitId: string | null | undefined,
  config: PrefixRoutingConfig,
): SurfaceSyncAuthorityFeature | null {
  if (typeof branchOrWorkUnitId !== "string") {
    return null;
  }
  if (BD_SHORT_SURFACE_RE.test(branchOrWorkUnitId) || BD_LONG_SURFACE_RE.test(branchOrWorkUnitId)) {
    return "beads_issue";
  }
  const match = branchOrWorkUnitId.toUpperCase().match(ROUTING_PREFIX_RE);
  if (!match) {
    return null;
  }
  const prefix = match[1];
  return prefix ? config.features[prefix] ?? null : null;
}
