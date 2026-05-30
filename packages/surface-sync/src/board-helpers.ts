/**
 * Pure board-state helpers shared by the surface-sync transform and the github
 * board readers: issue-feature enablement, per-unit feature routing, feature
 * status extraction, status normalization, and GH issue-number parsing. All
 * pure; operate on the surface-sync contracts (config, snapshot, routing).
 */

import type { BoardSnapshotUnit } from "./snapshot.ts";
import type { SurfaceSyncConfig } from "./config.ts";
import type { SurfaceSyncAuthorityFeature, SurfaceSyncFeature } from "./surface.ts";
import { resolveFeatureForPrefix, type PrefixRoutingConfig } from "./routing.ts";

export function issueParityFeatureEnabled(
  config: SurfaceSyncConfig,
  feature: SurfaceSyncFeature,
): boolean {
  return config.features[feature];
}

export function issueFeatureForUnit(
  branch: string,
  routingConfig: PrefixRoutingConfig,
): SurfaceSyncAuthorityFeature | null {
  return resolveFeatureForPrefix(branch, routingConfig);
}

export function issueFeatureStatus(
  status: NonNullable<BoardSnapshotUnit["status"]>,
  feature: Extract<SurfaceSyncFeature, "gh_issue" | "beads_issue"> | null,
): string | null {
  if (feature === "gh_issue") {
    return status.remote.gh_issue;
  }
  if (feature === "beads_issue") {
    return status.remote.beads_issue;
  }
  return null;
}

export function normalizeIssueStatus(
  raw: string | null,
  enabled: boolean,
): "clean" | "dirty" | "completed" | "disabled" {
  if (!enabled) return "disabled";
  if (raw === "clean" || raw === "dirty" || raw === "completed" || raw === "disabled") {
    return raw;
  }
  return "disabled";
}

export function githubIssueNumberFromWorkUnitId(value: string): number | null {
  const match = value.match(/^GH-(\d+)$/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isNaN(parsed) ? null : parsed;
}
