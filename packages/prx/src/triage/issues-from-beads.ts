// GH-1602 — bd-substrate projection of GH issues for `prx triage` verbs.
//
// Pre-GH-1602, every triage verb except the comparators called
// `gh issue list … --json number,title,url,labels` once per invocation to
// enumerate the open queue. That's a GraphQL call per verb per pass against
// the same 5000-unit pool that GH-1245 / GH-1533 / GH-1602 are collectively
// trying to relieve. The bd substrate is the canonical store for the axis
// fields these verbs read (type/priority/area/effort labels are bd→external
// projections; authority ADR §2), and `pruneMergedActor` runs the canonical
// status-only reconcile `runBeadsSync` at the head of every triage machine
// pass (`triage/prune-merged.ts`) to fold any GH-side closures into bd before
// the queue is enumerated. So every field a non-comparator verb needs to
// enumerate the queue — number, title, url, labels — is already in
// `bd list --json`. (GH-2316 retired the prior destructive GH→bd pull here;
// it never wrote labels/priority back into bd anyway — bd is authoritative.)
//
// This module is the substitute. The exported helpers are shape-compatible
// drop-ins for `listOpenIssues` / `listIssuesByState` (same `FallbackIssue[]`
// return type), and the call sites in each triage verb's `runScanPhase`
// switch their default dep from the gh-side function to one of these. Tests
// inject their own fakes; the production default just shifts source-of-truth.
//
// Invariant
// ---------
// `pruneMergedActor` runs first in `triageMachine` (`triage/machine.ts:188 –
// initial: "pruneMerged"`). It runs the canonical status-only reconcile
// (`runBeadsSync`) so by the time any other actor runs, `bd list --json`
// reflects GH-side closures. If a future refactor lets a triage verb run
// without `pruneMerged` having just reconciled, this projection sees a stale
// substrate and the verb's queue silently shrinks. The triage machine's
// initial-state assertion is the load-bearing guard; an integration test
// pins it.
//
// Out of scope: `runStatusActor`'s drift / forward-orphan / stale comparators.
// Those by definition need the gh side, not the bd-mirror of the gh side —
// `listOpenIssues` / `listIssuesByState` remain gh-authoritative there,
// wrapped in `withGhTruthReason` so the rate-limit audit row identifies the
// load-bearing reason.

import { processEnv } from "@bounded-systems/env";
import { execBd as defaultExecBd, type BdExecResult } from "@bounded-systems/bd";
import type { FallbackIssue, GitHubIssueState } from "../pr-state/github.ts";
import { extractIssueNumber } from "./triage.ts";

/**
 * Compile a `<owner>/<repo>` into the regex anchor for `external_ref` URLs
 * pointing at that repo's issues. Matches both `http://` and `https://`
 * forms; the trailing path is captured for issue-number extraction by
 * `extractIssueNumber` (kept consistent with the legacy URL fallback used in
 * `triage.ts`).
 */
function repoIssueUrlMatcher(repo: string): RegExp {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^https?://github\\.com/${escaped}/issues/\\d+(?:[/?#].*)?$`, "i");
}

/**
 * The shape of a bd-mirrored GH issue inside `bd list --json`. Soft contract
 * — bd's CLI does not validate `metadata`, so missing/null fields degrade to
 * "skip this row" rather than throwing. Mirrors the parsing tolerance in
 * `loadAllBeads`.
 */
type BdListRow = {
  external_ref?: unknown;
  metadata?: unknown;
  status?: unknown;
  title?: unknown;
  labels?: unknown;
};

function readBdList(exec: typeof defaultExecBd): unknown[] {
  const result: BdExecResult = exec(
    {
      subcommand: "list",
      args: ["--all", "--json", "--limit", "0"],
      state: "planning",
      role: "planner",
    },
    processEnv(),
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "bd list --json failed";
    throw new Error(`issues-from-beads: ${detail}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout || "[]");
  } catch {
    throw new Error("issues-from-beads: bd list --json returned invalid JSON");
  }
  if (!Array.isArray(raw)) {
    throw new Error("issues-from-beads: expected bd list --json to return an array");
  }
  return raw;
}

/**
 * Best-effort GH external-ref URL for a bd row. Mirrors the GH-1538 precedence
 * `loadAllBeads` uses: prefer `external_ref` (the legacy single-pin slot,
 * what `bd update --external-ref` writes), fall back to
 * `metadata.external_refs.gh` (the post-GH-1500-amendment multi-domain map).
 * Returns `null` when neither slot is set or is non-string.
 */
function resolveGhRef(row: BdListRow): string | null {
  const legacy = typeof row.external_ref === "string" ? row.external_ref.trim() : "";
  if (legacy.length > 0) return legacy;
  const metadata =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : null;
  const externalRefs =
    metadata
    && metadata.external_refs
    && typeof metadata.external_refs === "object"
    && !Array.isArray(metadata.external_refs)
      ? (metadata.external_refs as Record<string, unknown>)
      : null;
  if (!externalRefs) return null;
  const gh = externalRefs.gh;
  if (typeof gh !== "string") return null;
  const trimmed = gh.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Project the flat `labels: string[]` shape `bd list --json` emits into the
 * `FallbackIssue.labels: { name }[]` shape every triage consumer reads.
 * `null`/missing collapses to an empty array — every consumer guards with
 * `issue.labels ?? []`, so this preserves that invariant.
 */
function projectLabels(value: unknown): FallbackIssue["labels"] {
  if (!Array.isArray(value)) return [];
  const out: NonNullable<FallbackIssue["labels"]> = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) out.push({ name: entry });
  }
  return out;
}

function projectRow(row: BdListRow, repoMatcher: RegExp): FallbackIssue | null {
  const url = resolveGhRef(row);
  if (url === null) return null;
  if (!repoMatcher.test(url)) return null;
  const number = extractIssueNumber(url);
  if (number === null) return null;
  return {
    number,
    title: typeof row.title === "string" ? row.title : "",
    url,
    labels: projectLabels(row.labels),
  };
}

function applyLimit(issues: FallbackIssue[], limit: number): FallbackIssue[] {
  if (limit <= 0) return issues;
  return issues.length > limit ? issues.slice(0, limit) : issues;
}

/**
 * bd-resident drop-in for `listOpenIssues`. Returns every open (non-closed) bd
 * row whose GH external-ref points at `repo`, projected to `FallbackIssue`.
 * `limit` mirrors the gh helper's `--limit N` semantics (0 = "no cap" via the
 * legacy default of 5; callers pass an explicit positive limit). Stable order:
 * preserves bd's row order from `bd list --json`, which is the same order
 * `loadAllBeads` consumes.
 */
export function listOpenIssuesFromBeads(
  repo: string,
  limit: number,
  exec: typeof defaultExecBd = defaultExecBd,
): FallbackIssue[] {
  const rows = readBdList(exec);
  const matcher = repoIssueUrlMatcher(repo);
  const out: FallbackIssue[] = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as BdListRow;
    if (typeof row.status === "string" && row.status === "closed") continue;
    const projected = projectRow(row, matcher);
    if (projected) out.push(projected);
  }
  return applyLimit(out, limit);
}

/**
 * bd-resident drop-in for `listIssuesByState`. Filters by `state` against bd's
 * `status` column: `open` → non-closed rows; `closed` → closed rows; `all` →
 * no filter. The gh helper's `--state all` includes both open and closed, so
 * we mirror that.
 */
export function listIssuesByStateFromBeads(
  repo: string,
  state: GitHubIssueState,
  limit: number,
  exec: typeof defaultExecBd = defaultExecBd,
): FallbackIssue[] {
  const rows = readBdList(exec);
  const matcher = repoIssueUrlMatcher(repo);
  const out: FallbackIssue[] = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as BdListRow;
    const status = typeof row.status === "string" ? row.status : "open";
    if (state === "open" && status === "closed") continue;
    if (state === "closed" && status !== "closed") continue;
    const projected = projectRow(row, matcher);
    if (projected) out.push(projected);
  }
  return applyLimit(out, limit);
}
