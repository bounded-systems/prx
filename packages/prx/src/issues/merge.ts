/**
 * Shared GH⇄bd merge + table-renderer for read verbs (`prx intake search`,
 * `prx plan search`). Originally inlined in `src/plan-store/plan-search.ts`
 * (GH-1186); extracted to `src/issues/` so the intake-side twin can dedupe
 * by external_ref and surface the bd id alongside the GH ref (GH-1780).
 *
 * Pure helpers: `mergeIssueHits` collapses GH+bd pairs into a single hit
 * tagged `source: "both"` with `beadId` populated; `formatIssueSearchTable`
 * renders the 5-column `id state source bd-id title` plain-text table. The
 * `bd-id` column stays present even when no rows are promoted (padded blanks)
 * so column order is stable across queries.
 */

import { buildBeadsLookup, lookupBead } from "./dedupe.ts";
import type { IssueSearchHit } from "./search.ts";
import type { BeadsRecord } from "../triage/triage.ts";

// Dedupe: when a GH hit's URL matches a bd record's external_ref, collapse
// the pair into a single hit with `source: "both"` and surface the bd id
// alongside. bd-only hits (no external_ref pointing at a GH search hit) and
// GH-only hits (no bd record claims them) pass through untouched.
export function mergeIssueHits(
  ghHits: IssueSearchHit[],
  bdHits: IssueSearchHit[],
  bdRecords: BeadsRecord[],
): IssueSearchHit[] {
  if (bdRecords.length === 0) {
    return [...ghHits, ...bdHits];
  }
  const lookup = buildBeadsLookup(bdRecords);
  const matchedBdIds = new Set<string>();
  const merged: IssueSearchHit[] = [];

  for (const gh of ghHits) {
    const number = Number.parseInt(gh.id.replace(/^GH-/, ""), 10);
    if (!Number.isFinite(number)) {
      merged.push(gh);
      continue;
    }
    const bead = lookupBead({ number, url: gh.url }, lookup);
    if (bead) {
      matchedBdIds.add(bead.id);
      merged.push({
        ...gh,
        source: "both",
        beadId: bead.id,
      });
    } else {
      merged.push(gh);
    }
  }

  for (const bd of bdHits) {
    if (matchedBdIds.has(bd.id)) continue;
    merged.push(bd);
  }

  return merged;
}

export function formatIssueSearchTable(hits: IssueSearchHit[]): string {
  const idWidth = Math.max(2, ...hits.map((h) => h.id.length));
  const stateWidth = Math.max(5, ...hits.map((h) => h.state.length));
  const sourceWidth = Math.max(6, ...hits.map((h) => h.source.length));
  const beadWidth = Math.max(6, ...hits.map((h) => (h.beadId ? h.beadId.length : 0)));
  const lines: string[] = [];
  lines.push(
    `${"id".padEnd(idWidth)}  ${"state".padEnd(stateWidth)}  ${"source".padEnd(sourceWidth)}  ${"bd-id".padEnd(beadWidth)}  title`,
  );
  for (const hit of hits) {
    const beadCol = (hit.beadId ?? "").padEnd(beadWidth);
    lines.push(
      `${hit.id.padEnd(idWidth)}  ${hit.state.padEnd(stateWidth)}  ${hit.source.padEnd(sourceWidth)}  ${beadCol}  ${hit.title}`,
    );
  }
  return lines.join("\n");
}
