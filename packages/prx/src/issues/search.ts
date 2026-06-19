/**
 * Shared GH+bd search primitives for read verbs (`prx intake search`,
 * `prx plan search`, future `prx triage search`). Originally lived in
 * `src/intake/intake-search.ts`.
 *
 * `searchGh` is a thin wrapper over `gh issue list --search …`; `searchBd`
 * is a case-insensitive title-substring filter over `bd list --all` records.
 * Plan-side adds dedupe by external_ref (see `src/issues/dedupe.ts`).
 */

import { processEnv } from "@bounded-systems/env";
import type { execGh, GhExecResult } from "@bounded-systems/gh";
import type { BeadsRecord } from "../triage/triage.ts";

export type IssueSearchHit = {
  id: string;
  state: string;
  title: string;
  url?: string | undefined;
  source: "gh" | "bd" | "both";
  beadId?: string | undefined;
};

export class IssueSearchError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "IssueSearchError";
    this.exitCode = exitCode;
  }
}

export function searchGh(
  query: string,
  state: "open" | "closed" | "all",
  exec: typeof execGh,
  verbLabel = "prx issue search",
  limit = 20,
): IssueSearchHit[] {
  const result: GhExecResult = exec(
    {
      group: "issue",
      subcommand: "list",
      args: [
        "--search",
        query,
        "--state",
        state,
        "--limit",
        String(limit),
        "--json",
        "number,title,state,url,labels",
      ],
      state: "planning",
      role: "planner",
    },
    processEnv(),
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "gh issue list failed";
    throw new IssueSearchError(`${verbLabel}: ${detail}`, result.exitCode || 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout || "[]");
  } catch {
    throw new IssueSearchError(`${verbLabel}: gh issue list --json returned invalid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new IssueSearchError(`${verbLabel}: gh issue list --json did not return an array`);
  }
  const hits: IssueSearchHit[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const r = entry as Record<string, unknown>;
    const number = typeof r.number === "number" ? r.number : null;
    if (number === null) continue;
    hits.push({
      id: `GH-${number}`,
      state: typeof r.state === "string" ? r.state : "",
      title: typeof r.title === "string" ? r.title : "",
      url: typeof r.url === "string" ? r.url : undefined,
      source: "gh",
    });
  }
  return hits;
}

export function searchBd(
  query: string,
  records: BeadsRecord[],
  state: "open" | "closed" | "all" = "all",
): IssueSearchHit[] {
  const needle = query.toLowerCase();
  const hits: IssueSearchHit[] = [];
  for (const record of records) {
    if (!record.title.toLowerCase().includes(needle)) continue;
    if (state !== "all" && !matchesBdState(record.status, state)) continue;
    hits.push({
      id: record.id,
      state: record.status,
      title: record.title,
      source: "bd",
    });
  }
  return hits;
}

// bd's status vocabulary doesn't map 1:1 to GH's open/closed: `closed` is
// terminal, `open`/`in_progress`/`blocked`/`ready` are all "open" from the
// operator's filter perspective. Keep the same partition GH uses for its
// `--state` flag so plan/intake search behave consistently across sources.
function matchesBdState(status: string, filter: "open" | "closed"): boolean {
  const isClosed = status === "closed";
  return filter === "closed" ? isClosed : !isClosed;
}
