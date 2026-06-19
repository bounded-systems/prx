/**
 * `prx plan search <query>` — unified GH+bd issue queue search for the plan
 * operator session (GH-1186, planner-side twin of `prx intake search`).
 *
 * Routes through the shared `src/issues/search.ts` core; the cross-source
 * dedupe and 5-column table renderer live in `src/issues/merge.ts` (GH-1780),
 * so the intake- and plan-side twins share the same `mergeIssueHits` +
 * `formatIssueSearchTable` path.
 *
 * Pure read; sits upstream of the parity chain; emits no XState events,
 * touches no schema. bd unreachability degrades gracefully (warn once,
 * continue with GH-only results) per the intake-search precedent.
 */

import { z } from "zod";

import { mergeIssueHits, formatIssueSearchTable } from "../issues/merge.ts";
import { IssueSearchError, searchBd, searchGh, type IssueSearchHit } from "../issues/search.ts";
import { execGh } from "@bounded-systems/gh";
import type { BeadsRecord } from "../triage/triage.ts";
// GH-296: search is a scout-shaped aggregate read — route it through the daemon.
import { loadAllBeadsViaDaemon } from "../beadsd/reads.ts";

export const planSearchOptionsSchema = z.object({
  query: z.string().trim().min(1, "query must not be empty"),
  state: z.enum(["open", "closed", "all"]).default("all"),
  source: z.enum(["gh", "beads", "both"]).default("both"),
  limit: z.number().int().positive().default(20),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type PlanSearchOptions = z.infer<typeof planSearchOptionsSchema>;

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type PlanSearchHit = IssueSearchHit;

export type PlanSearchRender = {
  query: string;
  state: "open" | "closed" | "all";
  source: "gh" | "beads" | "both";
  hits: PlanSearchHit[];
};

export type PlanSearchDeps = {
  execGh?: typeof execGh;
  /** GH-296: daemon-routed aggregate read (default {@link loadAllBeadsViaDaemon}). */
  loadBeads?: () => Promise<BeadsRecord[]>;
};

const VERB = "prx plan search";

export async function runPlanSearch(
  opts: PlanSearchOptions,
  output: Output,
  deps: PlanSearchDeps = {},
): Promise<number> {
  const ghExec = deps.execGh ?? execGh;
  const loadBeads = deps.loadBeads ?? loadAllBeadsViaDaemon;

  let ghHits: PlanSearchHit[] = [];
  if (opts.source === "gh" || opts.source === "both") {
    try {
      ghHits = searchGh(opts.query, opts.state, ghExec, VERB, opts.limit);
    } catch (err) {
      if (err instanceof IssueSearchError) {
        output.error(err.message);
        return err.exitCode;
      }
      throw err;
    }
  }

  let bdHits: PlanSearchHit[] = [];
  let bdRecords: BeadsRecord[] | null = null;
  if (opts.source === "beads" || opts.source === "both") {
    try {
      // Load records once: we need both the search hits *and* the raw record
      // set (for cross-source dedupe by external_ref). `searchBd` re-loads
      // internally, so we accept the small redundancy to keep the dedupe
      // path purely a function of the loaded records.
      bdRecords = await loadBeads();
      bdHits = searchBd(opts.query, bdRecords, opts.state);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const fallback =
        opts.source === "both" ? "continuing with GH-only results" : "no results returned";
      output.error(`${VERB}: bd unreachable: ${detail}; ${fallback}`);
      bdRecords = null;
    }
  }

  const merged = mergeIssueHits(ghHits, bdHits, bdRecords ?? []);

  // Apply --limit as an upper bound on the merged result, mirroring the
  // intake-search default of 20. GH already enforced its own `--limit` per the
  // searchGh wrapper; the merged cap protects the bd side from runaway result
  // counts when `--source beads` is used.
  const capped = merged.slice(0, opts.limit);

  const render: PlanSearchRender = {
    query: opts.query,
    state: opts.state,
    source: opts.source,
    hits: capped,
  };

  output.log(formatPlanSearchRender(render, opts.format));
  return 0;
}

export function formatPlanSearchRender(render: PlanSearchRender, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(render, null, 2);
  }
  if (render.hits.length === 0) {
    return `(no hits for query: ${render.query})`;
  }
  return formatIssueSearchTable(render.hits);
}
