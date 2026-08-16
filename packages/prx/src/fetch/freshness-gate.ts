// GH-1786 — read-time freshness gate shared by `prx scout issues` and
// `prx triage status`. Both verbs read the local bd substrate; before they
// do, they check the `prx.fetch.gh-issues.watermark` age and trigger one
// bounded `runFetchGhIssues` refresh when it's stale (or unset). On
// refresh failure they continue best-effort against the stale substrate
// with a structured reason attached to the verb summary.
//
// The gate is documentary inside the `prx` actor's accepted `status` op —
// no new model-level events, no new watermark key, no new write hooks. The
// fetch actor's existing per-page advance (I-F4 / I-F5) is the only thing
// that ever mutates `prx.fetch.gh-issues.watermark`; this module only
// reads.
//
// Extracted to break the scout↔triage circular import (`scout/issues.ts`
// imports `BeadsRecord` from `triage/triage.ts`, which now also wants the
// gate primitives). Lives next to `watermark.ts` because it composes the
// watermark reader with the fetch orchestrator.

import { getWatermark } from "./watermark.ts";
import { runFetchGhIssues as defaultRunFetchGhIssues, FetchGhIssuesError } from "./gh-issues.ts";

export type Staleness = "fresh" | "warn" | "stale" | "unknown";

/**
 * Outcome of one refresh attempt. Best-effort: a `failed` outcome attaches
 * a `reason` so the caller can pass the staleness through to the verb
 * summary rather than escalating into a hard error.
 */
export type SubstrateRefreshOutcome = { ok: true } | { ok: false; reason: string };

export type SubstrateRefresher = (args: {
  repo: string | undefined;
  cwd: string;
}) => SubstrateRefreshOutcome;

/**
 * Refresh-trigger skip-gate threshold passed to `runFetchGhIssues` as
 * `input.budget`. Bounds the read-time refresh so a single scout/triage
 * invocation can't drain the GraphQL bucket: the fetch actor decides
 * `skip` when `pointsAvailable < budget`, exiting 0 with a stale-
 * passthrough reason that this module surfaces on the summary.
 */
export const DEFAULT_REFRESH_BUDGET_POINTS = 50;

/**
 * TTL comparison. `unknown` is reserved for cold-start (no watermark ever
 * written) so the operator can distinguish "first run" from "stale enough
 * to refresh". `fresh` vs `stale` is a flat threshold check against the
 * operator-supplied `maxStaleness` budget (default 24h).
 */
export function classifyStaleness(
  watermark: string | null,
  maxStaleness: string,
  now: Date = new Date(),
): Staleness {
  if (watermark === null) return "unknown";
  const watermarkMs = Date.parse(watermark);
  if (!Number.isFinite(watermarkMs)) return "unknown";
  const budgetMs = parseStalenessDurationMs(maxStaleness);
  if (budgetMs === null) return "unknown";
  if (!Number.isFinite(budgetMs)) return "fresh";
  const ageMs = now.getTime() - watermarkMs;
  return ageMs < budgetMs ? "fresh" : "stale";
}

/**
 * `<n><unit>` duration parser (units: s/m/h/d; bare number reads as
 * minutes for symmetry with `parseDurationMs` in cli.ts). Returns `null`
 * for garbled input; `Infinity` is reserved for the `--no-refresh` opt-out
 * path which routes around the classifier entirely.
 */
export function parseStalenessDurationMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === "Infinity") return Number.POSITIVE_INFINITY;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(trimmed);
  if (!m) return null;
  const n = Number.parseFloat(m[1]!);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] ?? "m").toLowerCase();
  const scale =
    unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Math.round(n * scale);
}

/**
 * Reads `prx.fetch.gh-issues.watermark` via the production `getWatermark`
 * wrapper. Returns `null` when the key is unset (cold-start) or when the
 * spawn fails — the failure mode is treated as cold-start so a missing bd
 * binary doesn't escalate a read-only verb into a hard error. The fetch
 * actor surfaces `WATERMARK_READ_FAILED` itself if the refresh trigger
 * actually runs and bd is genuinely unreachable.
 */
export function readSubstrateWatermark(
  cwd: string,
  // Injectable (defaults to the real bd-backed reader) so the read + catch are
  // testable without a live bd substrate.
  read: typeof getWatermark = getWatermark,
): string | null {
  try {
    return read({ cwd }).since;
  } catch {
    return null;
  }
}

/**
 * Production refresh trigger. Wraps `runFetchGhIssues` with a bounded
 * budget so a single scout/triage invocation can't drain the GraphQL
 * bucket; any error is translated to a stale-passthrough reason so the
 * caller can continue reading from the still-stale substrate.
 */
export function defaultSubstrateRefresher(
  {
    repo,
    cwd,
  }: {
    repo: string | undefined;
    cwd: string;
  },
  // Injectable (defaults to the real fetch actor) so the go/skip/fail/error
  // arms are testable without a live gh/bd substrate.
  fetch: typeof defaultRunFetchGhIssues = defaultRunFetchGhIssues,
): SubstrateRefreshOutcome {
  try {
    const result = fetch(
      {
        source: "gh-issues",
        ...(repo !== undefined ? { repo } : {}),
        budget: DEFAULT_REFRESH_BUDGET_POINTS,
        dryRun: false,
      },
      { cwd },
    );
    if (result.plan.decision === "go") return { ok: true };
    // `skip` / `fail` exited 0 / 65 respectively at the actor; treat both
    // as best-effort no-ops here and attach the rationale so the operator
    // can see why the substrate is still stale.
    return {
      ok: false,
      reason: `fetch ${result.plan.decision}: ${result.plan.rationale}`,
    };
  } catch (err) {
    if (err instanceof FetchGhIssuesError) {
      return { ok: false, reason: `fetch ${err.code}: ${err.message}` };
    }
    return { ok: false, reason: (err as Error).message ?? String(err) };
  }
}
