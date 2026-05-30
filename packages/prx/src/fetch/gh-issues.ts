// GH-1245 → GH-1603 — `prx fetch gh-issues` orchestrator.
//
// The verb has three halves:
//   • `computeFetchPlan` — pure function over (input, budget, watermark,
//     corpusSize). Encodes I-F2 / I-F3 (decision = skip / fail). No I/O,
//     so the unit tests pin it independently of `bd`, `gh`, and the
//     budget cache.
//   • `runFetchGhIssues` — deps-injected orchestrator. Refreshes the
//     budget, reads the watermark, probes the corpus via native GraphQL
//     (`probeCorpusCount` — see docs/fetch-spike-retro.md §Q3 for the
//     transport decision that retired the dead `bd github sync
//     --dry-run` heuristic), folds the four inputs into the pure
//     function, and emits one JSON envelope.
//   • Write loop (GH-1603) — when `dryRun=false` and `decision === "go"`,
//     paginates through GraphQL pages and writes each one to bd
//     atomically (I-F4) with a per-page watermark advance (I-F5).
//
// I-F6: `dryRun: true` ⇒ exactly one GraphQL count probe and zero
// `bd create|update|config set` calls. The test catalog asserts this
// against the bd-spawn counter mock; the schema-level hard-true `dryRun`
// literal that previously enforced "no writes" is gone (replaced by the
// runtime guarantee here).

import {
  type BudgetSnapshot,
  BucketBudgetExhaustedError,
  refreshBudget,
  type RateLimitDeps,
  estimateSweepCost,
} from "@bounded-systems/github-budget";
import {
  fetchIssuesPage,
  GhGraphqlError,
  probeCorpusCount,
  type GhGraphqlDeps,
  type GhIssueRow,
} from "./gh-issues-graphql.ts";
import {
  FetchWriteError,
  writePage,
  type FetchCreateBeadResult,
  type FetchWriteDeps,
} from "./gh-issues-writer.ts";
import { repoNameWithOwner as defaultRepoNameWithOwner } from "../pr-state/github.ts";
import type { CommandRunner } from "../pr-state/github.ts";
import { GhDomainAdapter } from "../adapters/github.ts";
import {
  loadAllBeads as defaultLoadAllBeads,
  type BeadsRecord,
} from "../triage/triage.ts";
import {
  runIntakeMirror as defaultRunIntakeMirror,
  type IntakeMirrorRender,
} from "../intake/intake-mirror.ts";
import {
  DEFAULT_SAFETY_MARGIN,
  type FetchBudget,
  type FetchDecision,
  type FetchGhIssuesInput,
  type FetchPageResult,
  type FetchPlan,
  type FetchRunSummary,
} from "./types.ts";
import {
  getWatermark,
  setWatermark,
  type WatermarkDeps,
  WatermarkError,
} from "./watermark.ts";

export class FetchGhIssuesError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "FetchGhIssuesError";
    this.code = code;
  }
}

/**
 * Pure cost projection. Same inputs → same outputs; no spawn, no
 * filesystem, no budget refresh. Decision rules (spike doc §7 + I-F2/I-F3):
 *
 *   • `fail`  ← `budget.remaining === 0` OR caller signalled gate-thrown.
 *   • `skip`  ← `budget.remaining < estimatedPoints × safetyMargin`.
 *   • `go`    ← otherwise. An empty corpus still emits `go` with 0 points
 *               (per §8 — operator wants to advance the watermark to "now"
 *               on a next-write run).
 *
 * `corpusSize` is the GraphQL `totalCount` for the active `since` filter.
 * Cost is `ceil(corpusSize / 100) × sweepAvg` — page-of-100 maps to one
 * GraphQL request; `sweepAvg` is the rolling per-call cost from
 * `estimateSweepCost` (or the post-spike retro's authoritative
 * `rateLimit.cost` block once one is observed).
 */
export function computeFetchPlan(args: {
  input: FetchGhIssuesInput;
  budget: FetchBudget;
  watermark: { since: string | null };
  corpusSize: number;
  sweepAvgPoints: number;
  safetyMargin?: number | undefined;
  now: Date;
  gateThrew?: boolean | undefined;
}): FetchPlan {
  const margin = args.safetyMargin ?? DEFAULT_SAFETY_MARGIN;
  const corpus = Math.max(0, Math.floor(args.corpusSize));
  const estimatedRequests = corpus === 0 ? 0 : Math.ceil(corpus / 100);
  const estimatedPoints = Math.ceil(estimatedRequests * args.sweepAvgPoints);

  const overrideThreshold = args.input.budget;
  const required = overrideThreshold !== undefined
    ? overrideThreshold
    : Math.ceil(estimatedPoints * margin);

  // I-F3: hard exhaust ⇒ fail. The pure projection has no other way to
  // tell hard-fail from skip — the caller signals `gateThrew` when
  // `refreshBudget` returned null or the gate raised an exhaustion.
  if (args.gateThrew || args.budget.pointsAvailable === 0) {
    return makePlan({
      estimatedPoints,
      estimatedRequests,
      watermark: args.watermark,
      now: args.now,
      decision: "fail",
      rationale:
        `hard rate exhaust: ${args.budget.pointsAvailable} points available ` +
        `(resets ${args.budget.resetAt})`,
    });
  }

  // §8: empty corpus → go with 0 points, watermark advances to "now".
  if (estimatedPoints === 0) {
    return makePlan({
      estimatedPoints: 0,
      estimatedRequests: 0,
      watermark: args.watermark,
      now: args.now,
      decision: "go",
      rationale: "empty delta — nothing to fetch",
    });
  }

  // I-F2: soft gate. Below margin → skip and exit 0 with stderr explanation.
  if (args.budget.pointsAvailable < required) {
    return makePlan({
      estimatedPoints,
      estimatedRequests,
      watermark: args.watermark,
      now: args.now,
      decision: "skip",
      rationale:
        `budget gate: ${args.budget.pointsAvailable} available < ` +
        `${required} required (estimated ${estimatedPoints} × margin ${margin})`,
    });
  }

  return makePlan({
    estimatedPoints,
    estimatedRequests,
    watermark: args.watermark,
    now: args.now,
    decision: "go",
    rationale:
      `${estimatedPoints} points projected over ${estimatedRequests} request(s); ` +
      `${args.budget.pointsAvailable} available`,
  });
}

function makePlan(args: {
  estimatedPoints: number;
  estimatedRequests: number;
  watermark: { since: string | null };
  now: Date;
  decision: FetchDecision;
  rationale: string;
}): FetchPlan {
  return {
    estimatedPoints: args.estimatedPoints,
    estimatedRequests: args.estimatedRequests,
    watermarkAdvanceTo: args.now.toISOString(),
    decision: args.decision,
    rationale: args.rationale,
  };
}

export type FetchGhIssuesDeps = {
  cwd: string;
  now?: () => Date;
  /** GraphQL transport deps — runner + rate-limit forwarding. */
  graphql?: GhGraphqlDeps;
  /** bd writer deps — admits an `execBd` shim and per-call env. */
  writer?: FetchWriteDeps;
  /** Watermark wrapper deps (read + write). */
  watermarkRunner?: WatermarkDeps["runner"];
  /** Shared rate-limit deps (gate refresh + audit log location). */
  rateLimit?: RateLimitDeps;
  /** `gh repo view` / origin URL parse — defaults to the prod resolver. */
  repoResolver?: (cwd: string) => string;
  /** Runner forwarded to the default repo resolver when no override. */
  repoResolverRunner?: CommandRunner;
  /**
   * GH-1649 — bd snapshot loader for the write path's URL→bdId resolver.
   * Loaded once per run on the live+go+corpus>0 path (I-BF1). Defaults to
   * `loadAllBeads`. Injected so tests never touch a real bd.
   */
  loadBeadsSnapshot?: () => BeadsRecord[];
  /**
   * GH-1649 — URL→bd canonical long id resolver over the loaded snapshot.
   * Defaults to `GhDomainAdapter.resolveFromBeads` (I-BF1).
   */
  resolveBdId?: (url: string, beads: BeadsRecord[]) => string | null;
  /**
   * GH-1649 — create-from-external-record for an unmirrored row (I-BF2).
   * Defaults to a `runIntakeMirror` wrapper over the loaded snapshot.
   */
  createBead?: (args: { ghId: string; repo: string }) => FetchCreateBeadResult;
  safetyMargin?: number;
};

export type FetchGhIssuesResult = {
  plan: FetchPlan;
  /** GraphQL bucket snapshot used to make the decision. */
  budget: BudgetSnapshot;
  watermark: { since: string | null };
  /** Resolved `owner/name`. */
  repo: string;
  /** Total issue count reported by the GraphQL probe under the `since` filter. */
  corpusSize: number;
  /**
   * Set when the verb wrote pages (`dryRun: false` + `decision === "go"`).
   * Null for dry-run, skip, fail. Captures the per-page audit so the JSON
   * envelope describes exactly what hit bd.
   */
  run: FetchRunSummary | null;
};

/**
 * Run the verb. Refresh budget → resolve repo → read watermark → native
 * GraphQL count probe → fold via `computeFetchPlan` → (when live + go)
 * paginated write loop with per-page watermark advance. Emits a single
 * envelope (`plan` is the §7 `FetchPlan`; the other fields are the
 * inputs + per-page audit so the retro doc and CAS payload have
 * everything they need to reproduce the decision).
 *
 * Failure modes:
 *   • refreshBudget returns null      → throw NO_BUDGET (exit 65)
 *   • gh api graphql non-zero exit    → throw GH_GRAPHQL_FAILED (exit 65)
 *   • gh api graphql unparseable JSON → throw GH_GRAPHQL_PARSE_FAILED (exit 65)
 *   • watermark read fails            → throw WATERMARK_READ_FAILED (exit 65)
 *   • budget remaining === 0          → plan.decision = "fail" (exit 65)
 *   • below margin                    → plan.decision = "skip" (exit 0)
 *   • dry-run                         → plan returned, no writes (exit 0)
 *   • write-loop bd update fails      → throw FETCH_WRITE_FAILED (exit 65),
 *                                       watermark NOT advanced for failed
 *                                       page (I-F4 + I-F5).
 */
export function runFetchGhIssues(
  input: FetchGhIssuesInput,
  deps: FetchGhIssuesDeps,
): FetchGhIssuesResult {
  const now = (deps.now ?? (() => new Date()))();

  // 1. Refresh budget. Returns null on a `gh api rate_limit` parse failure
  //    or non-zero exit — surface as a hard fail so the failure-mode
  //    catalog has a deterministic exit.
  const snapshots = refreshBudget(deps.rateLimit);
  if (!snapshots) {
    throw new FetchGhIssuesError(
      "could not refresh GitHub rate-limit budget",
      "NO_BUDGET",
    );
  }
  const graphql = snapshots.find((s) => s.bucket === "graphql");
  if (!graphql) {
    throw new FetchGhIssuesError(
      "rate-limit response missing graphql bucket",
      "NO_BUDGET",
    );
  }
  const budget: BudgetSnapshot = graphql;

  // 2. Resolve the `owner/name` slug. The CLI may pass it explicitly;
  //    otherwise read `git remote get-url origin` via the standard
  //    resolver (which also handles the `gh repo view` fallback).
  let repo: string;
  try {
    if (input.repo !== undefined) {
      repo = input.repo;
    } else if (deps.repoResolver) {
      repo = deps.repoResolver(deps.cwd);
    } else {
      repo = defaultRepoNameWithOwner(
        deps.cwd,
        deps.repoResolverRunner,
      );
    }
  } catch (err) {
    throw new FetchGhIssuesError(
      `repo resolution failed: ${(err as Error).message}`,
      "REPO_UNRESOLVED",
    );
  }
  if (!repo || repo.trim().length === 0) {
    throw new FetchGhIssuesError(
      "repo resolution returned empty slug",
      "REPO_UNRESOLVED",
    );
  }

  // 3. Read the watermark. Read failure here is its own failure mode
  //    (bd unreachable) — surface explicitly rather than silently
  //    pretending there's no prior watermark.
  let watermark: { since: string | null };
  try {
    watermark = getWatermark({ cwd: deps.cwd, runner: deps.watermarkRunner });
  } catch (err) {
    if (err instanceof WatermarkError) {
      throw new FetchGhIssuesError(
        `watermark read failed: ${err.message}`,
        "WATERMARK_READ_FAILED",
      );
    }
    throw err;
  }

  // 4. Native GraphQL count probe — replaces the dead `bd github sync
  //    --dry-run` + `parseBdDryRunDelta` heuristic.
  let corpusSize: number;
  try {
    const probe = probeCorpusCount(
      { repo, since: watermark.since },
      { ...deps.graphql, rateLimit: deps.rateLimit },
    );
    corpusSize = probe.totalCount;
  } catch (err) {
    if (err instanceof GhGraphqlError) {
      throw new FetchGhIssuesError(
        `gh api graphql (count probe): ${err.message}`,
        err.code,
      );
    }
    throw err;
  }

  // 5. Rolling per-call GraphQL cost from the audit log; cold-fallback
  //    is `COLD_FALLBACK_AVG = 2` inside estimateSweepCost.
  const estimate = estimateSweepCost(corpusSize, deps.rateLimit);
  const sweepAvgPoints = estimate.sample.avg;

  const fetchBudget: FetchBudget = {
    source: input.source,
    pointsAvailable: budget.remaining,
    resetAt: new Date(budget.resetAt).toISOString(),
    dailySpentPoints: 0,
  };

  const plan = computeFetchPlan({
    input,
    budget: fetchBudget,
    watermark,
    corpusSize,
    sweepAvgPoints,
    safetyMargin: deps.safetyMargin,
    now,
  });

  // 6. Skip / fail / dry-run / empty-corpus → no writes (I-F6). An empty
  //    delta (corpusSize === 0) still emits `decision === "go"` per the
  //    spike doc §8, but there's nothing to paginate; short-circuit so
  //    the live path doesn't issue a page query the count probe already
  //    proved would return zero nodes.
  if (input.dryRun || plan.decision !== "go" || corpusSize === 0) {
    return { plan, budget, watermark, repo, corpusSize, run: null };
  }

  // 6b. GH-1649 — load the bd snapshot once (I-BF1) and build the writer's
  //     resolve-or-create seams. Only reached on the live + go + corpus>0
  //     path (the dry-run/skip/fail/empty branch returned above), so I-F6
  //     is untouched. The adapter shares the warmed read, so the per-row
  //     URL→bdId resolution is in-process (no per-row bd spawn) and writes
  //     by the canonical long id positional (I-F7) — never bd's
  //     last-touched fallback.
  const beads = (deps.loadBeadsSnapshot ?? (() => defaultLoadAllBeads()))();
  const resolveFromBeads =
    deps.resolveBdId ??
    ((url: string, snapshot: BeadsRecord[]) =>
      new GhDomainAdapter({ loadAllBeads: () => snapshot }).resolveFromBeads(
        url,
        snapshot,
      ));
  const createBead =
    deps.createBead ??
    ((args: { ghId: string; repo: string }): FetchCreateBeadResult => {
      const captured: string[] = [];
      const capOut = {
        log: (l: string) => captured.push(l),
        error: (l: string) => captured.push(l),
      };
      const exit = defaultRunIntakeMirror(
        { ghId: args.ghId, repo: args.repo, dryRun: false, format: "json" },
        capOut,
        { loadAllBeads: () => beads },
      );
      const render = parseMirrorRender(captured);
      return {
        exitCode: exit,
        ...(render?.createdBdId ? { createdBdId: render.createdBdId } : {}),
        ...(render?.existingBdId ? { existingBdId: render.existingBdId } : {}),
      };
    });
  const writerDeps: FetchWriteDeps = {
    ...deps.writer,
    resolveBdId: (url: string) => resolveFromBeads(url, beads),
    createBead,
    repo,
  };

  // 7. Write loop — paginate ASC by updatedAt, write per page, advance
  //    the watermark to the page's max(updatedAt) after each successful
  //    bd write. I-F4 + I-F5 + I-F6 all live in this loop.
  const pages: FetchPageResult[] = [];
  let cursor: string | null = null;
  let pageNumber = 0;
  let lastWatermark: string | null = watermark.since;
  let pointsSpentTotal = 0;
  let rowsWrittenTotal = 0;

  while (true) {
    pageNumber += 1;
    let rows: GhIssueRow[];
    let hasNextPage: boolean;
    let endCursor: string | null;
    let pagePoints: number;
    try {
      const page = fetchIssuesPage(
        cursor,
        { repo, since: watermark.since },
        { ...deps.graphql, rateLimit: deps.rateLimit },
      );
      rows = page.nodes;
      hasNextPage = page.pageInfo.hasNextPage;
      endCursor = page.pageInfo.endCursor;
      pagePoints = page.rateLimit.cost ?? 0;
    } catch (err) {
      if (err instanceof GhGraphqlError) {
        throw new FetchGhIssuesError(
          `gh api graphql (page ${pageNumber}): ${err.message}`,
          err.code,
        );
      }
      if (err instanceof BucketBudgetExhaustedError) {
        // GH-1141 rate-limit detection. The prior pages (if any) already
        // committed + advanced the watermark — I-F4 + I-F5 are preserved
        // by simply propagating the failure here.
        throw new FetchGhIssuesError(
          `gh api graphql (page ${pageNumber}) budget exhausted: ${err.message}`,
          "BUDGET_EXHAUSTED",
        );
      }
      throw err;
    }
    pointsSpentTotal += pagePoints;

    if (rows.length === 0) {
      // Empty page — nothing to write, nothing to advance. Break out
      // (the `decision === "go"` path with corpusSize > 0 should normally
      // produce at least one row; this guards against eventual-consistency
      // races where the count probe saw N but pagination yields zero).
      pages.push({
        pageNumber,
        pointsSpent: pagePoints,
        rowsWritten: 0,
        lastUpdatedAt: lastWatermark ?? now.toISOString(),
        committed: true,
      });
      if (!hasNextPage) break;
      cursor = endCursor;
      continue;
    }

    let writeResult: { rowsWritten: number; lastUpdatedAt: string };
    try {
      writeResult = writePage(rows, pageNumber, lastWatermark, writerDeps);
    } catch (err) {
      if (err instanceof FetchWriteError) {
        pages.push({
          pageNumber,
          pointsSpent: pagePoints,
          rowsWritten: 0,
          lastUpdatedAt: lastWatermark ?? "",
          committed: false,
        });
        throw new FetchGhIssuesError(
          `fetch write failed at page ${pageNumber} row ${err.rowIndex}: ${err.stderr}`,
          "FETCH_WRITE_FAILED",
        );
      }
      throw err;
    }

    // Per-page watermark advance — must succeed before the next page can
    // claim "committed" status (I-F5: monotonicity is preserved by skipping
    // the advance if it fails).
    try {
      setWatermark(
        { cwd: deps.cwd, runner: deps.watermarkRunner },
        writeResult.lastUpdatedAt,
      );
    } catch (err) {
      pages.push({
        pageNumber,
        pointsSpent: pagePoints,
        rowsWritten: writeResult.rowsWritten,
        lastUpdatedAt: lastWatermark ?? "",
        committed: false,
      });
      throw new FetchGhIssuesError(
        `watermark write failed after page ${pageNumber}: ${
          (err as Error).message
        }`,
        "WATERMARK_WRITE_FAILED",
      );
    }

    rowsWrittenTotal += writeResult.rowsWritten;
    lastWatermark = writeResult.lastUpdatedAt;
    pages.push({
      pageNumber,
      pointsSpent: pagePoints,
      rowsWritten: writeResult.rowsWritten,
      lastUpdatedAt: writeResult.lastUpdatedAt,
      committed: true,
    });

    if (!hasNextPage) break;
    cursor = endCursor;
  }

  const run: FetchRunSummary = {
    pagesCommitted: pages.filter((p) => p.committed).length,
    totalRowsWritten: rowsWrittenTotal,
    totalPointsSpent: pointsSpentTotal,
    pages,
  };

  return { plan, budget, watermark, repo, corpusSize, run };
}

/**
 * Parse the first JSON object line from a captured `runIntakeMirror`
 * render (mirrors `src/sync/backfill.ts:318`). Returns null when no line
 * parses, so the writer treats the create as failed (I-F4: page does not
 * commit).
 */
function parseMirrorRender(captured: string[]): IntakeMirrorRender | null {
  for (const line of captured) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed) as IntakeMirrorRender;
    } catch {
      // fall through to the next captured line
    }
  }
  return null;
}

/** Render the result as a single JSON envelope for stdout. */
export function formatFetchGhIssuesJson(result: FetchGhIssuesResult): string {
  return JSON.stringify(
    {
      _summary: {
        source: "gh-issues",
        decision: result.plan.decision,
        repo: result.repo,
        estimatedPoints: result.plan.estimatedPoints,
        estimatedRequests: result.plan.estimatedRequests,
        pointsAvailable: result.budget.remaining,
        limit: result.budget.limit,
        resetAt: new Date(result.budget.resetAt).toISOString(),
        watermarkSince: result.watermark.since,
        corpusSize: result.corpusSize,
        rationale: result.plan.rationale,
        run: result.run,
      },
    },
    null,
    2,
  );
}
