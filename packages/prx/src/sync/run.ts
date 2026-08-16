// `prx sync` reconcile tick — retired to a typed no-op (GH-1012).
//
// This module used to drive the bd↔external-domain reconcile: enumerate the
// pinned `(bead, domain)` pairs, run each through `domainSyncMachine`, pull
// external status into bd, close stale beads, and push bd-authoritative
// title/body back to GitHub. GH-1012 removed the beads/dolt store entirely, so
// there is no bead set to enumerate and nothing to reconcile — the pull leg had
// no bd to write into and the push leg had no beads to read from.
//
// `runBeadsSync` is kept as an exported, typed no-op because it is still the
// "canonical reconcile" seam wired through many callers (the triage verbs and
// the pr-state close/sync paths). Each invocation now reports a zero reconcile
// and exits 0. `resolveThreshold` / `graphqlRemaining` survive as pure GraphQL-
// budget helpers reused by `src/sync/backfill.ts`.

import { getEnv } from "@bounded-systems/env";
import { refreshBudget as defaultRefreshBudget } from "@bounded-systems/github-budget";

// ── options + deps ─────────────────────────────────────────────────────────

export type RunBeadsSyncOptions = {
  /** OWNER/REPO. Defaults to `repoNameWithOwner(cwd)`. */
  repo?: string | undefined;
  /** Plan only. */
  dryRun: boolean;
  /** GraphQL-budget pause threshold; default `PRX_GH_BUDGET_THRESHOLD` ?? 100. */
  budget?: number | undefined;
  /** Domain to reconcile (historically `gh`, `notion`). */
  domain: string;
  /** Max pairs to reconcile this tick. */
  limit: number;
  format: "plain" | "json";
};

/**
 * Kept structurally for back-compat with the small number of callers that pass
 * a `deps` object (currently only `cwd`). Everything is optional and unused by
 * the no-op; retained so injected test/prod deps still type-check.
 */
export type RunBeadsSyncDeps = {
  cwd?: (() => string) | undefined;
  now?: (() => Date) | undefined;
};

// ── summary shape ──────────────────────────────────────────────────────────

export type BeadsSyncSummary = {
  repo: string;
  domain: string;
  scanned: number;
  pinned: number;
  skipped: number;
  pulled: number;
  pushed: number;
  closedByPull: number;
  failed: number;
  pullFailed: number;
  pullDeferred: number;
  pushDeferred: number;
  deferred: number;
  budgetPaused: boolean;
  dryRun: boolean;
  durationMs: number;
};

export type BeadsSyncPairDetail = {
  beadId: string;
  externalId: string;
  externalStatus: string;
  closedByPull: boolean;
  pushed: boolean;
  action: "synced" | "failed";
  message?: string;
};

export type BeadsSyncResult = {
  exitCode: number;
  summary: BeadsSyncSummary;
  pairs: BeadsSyncPairDetail[];
};

// ── budget helpers (reused by src/sync/backfill.ts) ─────────────────────────

// GH-1469: exported so the `prx sync backfill` routine reuses the same
// GraphQL-budget gate rather than re-deriving the threshold / remaining-bucket
// logic.
export const DEFAULT_BUDGET_THRESHOLD = 100;

export function resolveThreshold(opt: number | undefined): number {
  if (typeof opt === "number" && Number.isFinite(opt) && opt >= 0) return opt;
  const env = getEnv("PRX_GH_BUDGET_THRESHOLD");
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_BUDGET_THRESHOLD;
}

export function graphqlRemaining(
  snapshots: ReturnType<typeof defaultRefreshBudget>,
): number | null {
  if (!snapshots) return null;
  const gql = snapshots.find((s) => s.bucket === "graphql");
  return gql ? gql.remaining : null;
}

// ── the tick (no-op) ────────────────────────────────────────────────────────

function zeroSummary(domain: string, repo: string, dryRun: boolean): BeadsSyncSummary {
  return {
    repo,
    domain,
    scanned: 0,
    pinned: 0,
    skipped: 0,
    pulled: 0,
    pushed: 0,
    closedByPull: 0,
    failed: 0,
    pullFailed: 0,
    pullDeferred: 0,
    pushDeferred: 0,
    deferred: 0,
    budgetPaused: false,
    dryRun,
    durationMs: 0,
  };
}

/**
 * No-op reconcile tick (GH-1012). The bead store is gone, so there are no
 * pinned pairs to reconcile: report a zero summary and exit 0. Retained so the
 * canonical-reconcile callers keep compiling and behaving stably.
 */
export async function runBeadsSync(
  opts: RunBeadsSyncOptions,
  _output: { log: (line: string) => void; error: (line: string) => void },
  _deps: RunBeadsSyncDeps = {},
): Promise<BeadsSyncResult> {
  const repo = opts.repo?.trim() ?? "";
  return {
    exitCode: 0,
    summary: zeroSummary(opts.domain, repo, opts.dryRun),
    pairs: [],
  };
}
