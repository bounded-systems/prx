// GH-1245 → GH-1603 — Zod schemas for the `prx fetch gh-issues` verb.
//
// Originally drafted under the read-only fetch actor spike
// (docs/fetch-actor-spike.md §6). GH-1603 opens the write path: the
// schema-level `dryRun: z.literal(true)` is gone, paginated `bd update`
// writes happen atomically per page, and the watermark advances after
// each successful page (see docs/fetch-spike-retro.md §Q3 for the
// native-GraphQL transport decision that retired the dead shell-out
// probe).
//
// Invariants:
//   I-F1 — Replaced by I-F6 at runtime (see below). The schema layer no
//          longer enforces `dryRun=true` because the verb now writes; the
//          dry-run guarantee is asserted at test time by the bd-spawn
//          counter mock.
//   I-F2 — decision = "skip"  ⇔  pointsAvailable < estimatedPoints × safetyMargin.
//   I-F3 — decision = "fail"  ⇔  pointsAvailable === 0 OR gate threw.
//   I-F4 — Page atomicity. A page either fully writes (all N rows upserted
//          + watermark advanced) or commits nothing of itself. No partial-
//          page state is visible to bd readers or to the watermark.
//   I-F5 — Watermark monotonicity. The watermark never regresses. A failed
//          page leaves the watermark at the last successful page's
//          `max(updatedAt)`; on retry, the next run resumes from there.
//   I-F6 — Dry-run no-writes. `dryRun: true` ⇒ exactly one `gh api graphql`
//          count probe and zero `bd create|update|config set` calls.
//          Replaces I-F1's schema-level guarantee at the verb layer.

import { z } from "zod";

export const FetchSource = z.enum(["gh-issues"]);
export type FetchSource = z.infer<typeof FetchSource>;

export const FetchDecision = z.enum(["go", "skip", "fail"]);
export type FetchDecision = z.infer<typeof FetchDecision>;

export const FetchBudget = z.object({
  source: FetchSource,
  pointsAvailable: z.number().int().nonnegative(),
  resetAt: z.string().min(1),
  dailySpentPoints: z.number().int().nonnegative(),
});
export type FetchBudget = z.infer<typeof FetchBudget>;

export const FetchPlan = z.object({
  estimatedPoints: z.number().int().nonnegative(),
  estimatedRequests: z.number().int().nonnegative(),
  watermarkAdvanceTo: z.string().min(1),
  decision: FetchDecision,
  rationale: z.string().min(1),
});
export type FetchPlan = z.infer<typeof FetchPlan>;

// GH-1603: `dryRun` is now a regular boolean (default false). The runtime
// I-F6 guarantee (`dryRun: true` ⇒ zero bd writes) replaces the v0
// schema-level hard-true literal; the test catalog asserts I-F6 against
// the bd-spawn counter mock.
export const FetchGhIssuesInput = z.object({
  source: z.literal("gh-issues"),
  repo: z.string().min(1).optional(),
  since: z.string().min(1).optional(),
  budget: z.number().int().positive().optional(),
  dryRun: z.boolean().default(false),
});
export type FetchGhIssuesInput = z.infer<typeof FetchGhIssuesInput>;

// GH-1603 — per-page write outcome. One row per paginated graphql response
// that the orchestrator pushed to bd. `committed: true` means the page's
// rows all wrote AND `setWatermark` advanced past the page's
// `lastUpdatedAt`. A page that failed mid-write is recorded as
// `committed: false` with the partial counts captured so the failure
// envelope can describe what was lost (and what wasn't).
export const FetchPageResult = z.object({
  pageNumber: z.number().int().positive(),
  pointsSpent: z.number().int().nonnegative(),
  rowsWritten: z.number().int().nonnegative(),
  lastUpdatedAt: z.string().min(1),
  committed: z.boolean(),
});
export type FetchPageResult = z.infer<typeof FetchPageResult>;

// GH-1603 — run-level envelope returned by the write path. Adds the
// per-page breakdown on top of the read-only spike's result shape so the
// retro's I-F4 / I-F5 / I-F6 assertions are directly observable in the
// JSON envelope.
export const FetchRunSummary = z.object({
  pagesCommitted: z.number().int().nonnegative(),
  totalRowsWritten: z.number().int().nonnegative(),
  totalPointsSpent: z.number().int().nonnegative(),
  pages: z.array(FetchPageResult),
});
export type FetchRunSummary = z.infer<typeof FetchRunSummary>;

// Default safety margin per spike doc §7: a single fetch must not empty
// the bucket on a miscalibration, so reserve 50% headroom before deciding
// `go`.
export const DEFAULT_SAFETY_MARGIN = 1.5;
