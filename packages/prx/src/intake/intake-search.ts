/**
 * `prx intake search <query>` — unified GH+bd dedupe search for the intake
 * operator session (GH-999, part of GH-998). Replaces the raw
 * `gh issue list --search` + `bd list | grep` pair so GH-1004 can narrow the
 * intake profile allowlist to `Bash(prx intake:*)` only.
 *
 * Mirrors src/intake/intake-view.ts: pure read, no XState events, no schema
 * scaffolding. bd unreachability degrades gracefully per acceptance.
 *
 * GH-1186 extracted the shared `searchGh`/`searchBd` primitives into
 * `src/issues/search.ts`; GH-1780 extracted the `mergeIssueHits` +
 * `formatIssueSearchTable` helpers into `src/issues/merge.ts` so the
 * intake- and plan-side search twins share the same dedupe and render path.
 */

import { z } from "zod";

import { mergeIssueHits, formatIssueSearchTable } from "../issues/merge.ts";
import {
  IssueSearchError,
  searchBd,
  searchGh,
  type IssueSearchHit,
} from "../issues/search.ts";
import { execBd } from "@bounded-systems/bd";
import { execGh } from "@bounded-systems/gh";
import { loadAllBeads, type BeadsRecord } from "../triage/triage.ts";

export const intakeSearchOptionsSchema = z.object({
  query: z.string().trim().min(1, "query must not be empty"),
  state: z.enum(["open", "closed", "all"]).default("all"),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type IntakeSearchOptions = z.infer<typeof intakeSearchOptionsSchema>;

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type IntakeSearchHit = IssueSearchHit;

export type IntakeSearchRender = {
  query: string;
  state: "open" | "closed" | "all";
  hits: IntakeSearchHit[];
};

export type IntakeSearchDeps = {
  execGh?: typeof execGh;
  execBd?: typeof execBd;
  loadAllBeads?: typeof loadAllBeads;
};

export { IssueSearchError as IntakeSearchError };

const VERB = "prx intake search";

export function runIntakeSearch(
  opts: IntakeSearchOptions,
  output: Output,
  deps: IntakeSearchDeps = {},
): number {
  const ghExec = deps.execGh ?? execGh;
  const bdExec = deps.execBd ?? execBd;
  const loader = deps.loadAllBeads ?? loadAllBeads;

  let ghHits: IntakeSearchHit[];
  try {
    ghHits = searchGh(opts.query, opts.state, ghExec, VERB);
  } catch (err) {
    if (err instanceof IssueSearchError) {
      output.error(err.message);
      return err.exitCode;
    }
    throw err;
  }

  let bdHits: IntakeSearchHit[] = [];
  let bdRecords: BeadsRecord[] | null = null;
  try {
    // Load records once: we need both the search hits *and* the raw record
    // set (for cross-source dedupe by external_ref). `searchBd` re-loads
    // internally, so we accept the small redundancy to keep the dedupe path
    // purely a function of the loaded records. The loader routes a non-fatal
    // warning (bd exited non-zero but still emitted a valid array) through
    // `output.error`; warn and throw are mutually exclusive in `loadAllBeads`,
    // so the `catch` below still owns *genuine* bd-unreachable failures with
    // no double message.
    bdRecords = loader(bdExec, output.error);
    bdHits = searchBd(opts.query, () => bdRecords ?? [], bdExec, opts.state);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    output.error(
      `${VERB}: bd unreachable: ${detail}; continuing with GH-only results`,
    );
    bdRecords = null;
  }

  const render: IntakeSearchRender = {
    query: opts.query,
    state: opts.state,
    hits: mergeIssueHits(ghHits, bdHits, bdRecords ?? []),
  };

  output.log(formatIntakeSearchRender(render, opts.format));
  return 0;
}

export function formatIntakeSearchRender(
  render: IntakeSearchRender,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(render, null, 2);
  }
  if (render.hits.length === 0) {
    return `(no hits for query: ${render.query})`;
  }
  return formatIssueSearchTable(render.hits);
}
