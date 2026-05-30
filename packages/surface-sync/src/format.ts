/**
 * Surface-sync output formatter.
 *
 * Pure: a `SurfaceSyncResult` → human/JSON string. No I/O, no pr-state
 * helpers — the first piece of board *runtime* to land in this module
 * (see `docs/architecture/surface-sync-extraction.md`). The board reader
 * (`boardStatus`) and the plan builders remain in `src/pr-state/github.ts`
 * pending shared-infrastructure decoupling.
 */

import type { SurfaceSyncResult } from "./result.ts";

export function formatSurfaceSync(
  summary: SurfaceSyncResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(summary, null, 2);
  }

  const lines = [
    `${summary.apply ? "APPLY" : "PLAN"} reconcile`,
    `repo=${summary.repo}`,
    `mode=${summary.mode}`,
    `authority=${summary.authority}`,
    `scope=${summary.scope}`,
    ...(summary.ticket ? [`ticket=${summary.ticket}`] : []),
    `actions=${summary.actions.length}`,
  ];

  // GH-2147: a unit may carry `blockers` (reasons it was not reconciled) with
  // zero actions — surface those rather than reporting a bare "no actions".
  const hasBlockers = summary.units.some((unit) => (unit.blockers?.length ?? 0) > 0);

  if (summary.actions.length === 0 && !hasBlockers) {
    lines.push(
      summary.ticket
        ? `No reconciliation actions required for ${summary.ticket}.`
        : "No reconciliation actions required.",
    );
    return lines.join("\n");
  }

  for (const unit of summary.units) {
    const blockers = unit.blockers ?? [];
    if (unit.actions.length === 0 && blockers.length === 0) {
      continue;
    }
    lines.push("");
    lines.push(`${unit.branch} ticket=${unit.ticket ?? "none"}`);
    for (const action of unit.actions) {
      lines.push(`  - ${action.type}: ${action.reason}`);
    }
    for (const blocker of blockers) {
      lines.push(`  ! blocked: ${blocker}`);
    }
  }

  return lines.join("\n");
}
