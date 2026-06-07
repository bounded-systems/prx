// `prx beads sync` runtime — one budget-gated reconcile tick over the *known
// pinned* `(uow, domain)` pairs (GH-1537; the GH-1500 authority ADR §3a
// periodic push+pull job). Modelled structurally on `runDepResearch`: a CLI
// loop over a set of units, each driven through a per-unit XState machine
// (here `domainSyncMachine`, src/sync/machine.ts).
//
// This is *not* the discovery/backfill verb (GH-1469) — it only reconciles
// pairs that already carry a pin (`bead.externalRef`). Scheduling (launchd /
// cron) is the operator's job; "pause" = abort the tick, "resume" = the next
// scheduled tick re-scans (each pair is an idempotent re-reconcile, so no
// cursor is needed and SIGINT mid-tick is safe).
//
// Phase split (GH-2095 — invariant I-DS3: the pull leg of a domain-sync tick
// is never gated by `--limit`; only the push leg is):
//   1. pull phase — iterate every pinned pair and run the pull leg through a
//      machine spawned with `pushAllowed: false` (lands in `push_deferred`).
//      The only mid-loop cut is the GraphQL budget gate (counts the cut
//      pairs as `pullDeferred`).
//   2. close-apply phase — single `adapter.bulkClose({ beadIds })` over
//      every pulled pair whose `pullResult.needsClose` fired. The set is
//      the full pull-phase output, never the limit slice, so I-DS2 holds
//      end-to-end regardless of `--limit`.
//   3. push phase — re-sort (non-closed first, close-applied last, since
//      the closed issue's edits are lower-value) and run the first `limit`
//      pairs through the machine with `prefilledPullResult` (so `pulling`
//      is skipped). The rest count as `pushDeferred`.
//
// Field ownership (ADR §2 directional matrix):
//   - pull leg (external → bd): `status` only — close the bead when its GH
//     issue is CLOSED. The actual close is dispatched per-id through
//     `adapter.bulkClose({ cwd, beadIds })` — GH-2011 retired the repo-wide
//     bd-side reconcile shell-out because it destroyed bd-only writes for
//     `issue_type` / `assignee` / `state` / `close_reason`. The per-pair
//     `adapter.pull` is the *detection* (and the seam where the GH-1538
//     assignees/milestone apply slots in later).
//   - push leg (bd → external): `title` + `body` (bd-authoritative) via
//     `adapter.push(bead, { title, body })` — the linked `gh issue edit` path.
//     Non-axis label projection and push-side status-close are out of scope.

import { getEnv } from "@bounded-systems/env";
import { createActor } from "xstate";

// Side-effect import of the adapter barrel: registers every built-in
// `DomainAdapter` on the registry so `adapterForDomain(domain)` resolves
// inside the per-pair actors and the run loop's registry-membership check
// admits the domain.
import "../adapters/index.ts";
import { GhDomainAdapter } from "../adapters/index.ts";
import {
  adapterForDomain,
  registeredDomains,
  type DomainAdapter,
} from "../adapters/index.ts";
import { appendAuditRow as defaultAppendAuditRow } from "../audit/sink.ts";
import { getAuditRuntimeContext as defaultGetAuditRuntimeContext } from "@bounded-systems/audit-context";
import { refreshBudget as defaultRefreshBudget } from "@bounded-systems/github-budget";
import { repoNameWithOwner as defaultRepoNameWithOwner } from "../pr-state/github.ts";
import {
  loadAllBeads as defaultLoadAllBeads,
  type BeadsRecord,
} from "../triage/triage.ts";
import { domainSyncMachine } from "./machine.ts";
import type { DomainSyncPairContext, DomainSyncPairInput } from "./machine.ts";
import type { DomainSyncPullResult } from "./schemas.ts";
// GH-296 / prx-lzw — bd→GH push-leg short-circuit when the bead store is unchanged.
import { readDoltHead } from "../beadsd/dolt-head.ts";
import { createPushWatermark, type PushWatermark } from "./push-watermark.ts";
import { shouldSkipPush, advanceLastPushedHead } from "./push-freshness-gate.ts";

// ── options + deps ─────────────────────────────────────────────────────────

export type RunBeadsSyncOptions = {
  /** OWNER/REPO. Defaults to `repoNameWithOwner(cwd)`. */
  repo?: string | undefined;
  /** Plan only — no `gh issue edit`, no bd-side close-apply. */
  dryRun: boolean;
  /** GraphQL-budget pause threshold; default `PRX_GH_BUDGET_THRESHOLD` ?? 100. */
  budget?: number | undefined;
  /** Domain to reconcile; must be a registered `DomainAdapter` (currently `gh`, `notion`). */
  domain: string;
  /**
   * Max pinned pairs to push this tick (the rest are `pushDeferred`).
   * GH-2095: caps the push leg only — the pull leg + close-apply run over
   * every pinned pair every tick so a CLOSED-on-GH bead is never silently
   * skipped because its short id sorted past the limit slice.
   */
  limit: number;
  format: "plain" | "json";
};

export type RunBeadsSyncDeps = {
  cwd?: (() => string) | undefined;
  loadAllBeads?: typeof defaultLoadAllBeads | undefined;
  refreshBudget?: typeof defaultRefreshBudget | undefined;
  repoNameWithOwner?: ((path: string) => string) | undefined;
  appendAuditRow?: typeof defaultAppendAuditRow | undefined;
  getAuditRuntimeContext?: typeof defaultGetAuditRuntimeContext | undefined;
  now?: (() => Date) | undefined;
  /**
   * Test seam for the batched close-apply. When set, takes precedence over
   * `adapter.bulkClose` and the GH fallback — the existing GH-only test suite
   * (`I-DS2`) injects this directly. Production code paths should add a
   * `bulkClose` method to the domain adapter instead.
   */
  bulkClose?: ((cwd: string, dryRun: boolean) => { exitCode: number; stdout: string; stderr: string }) | undefined;
  /**
   * Override the per-pair adapter (test seam). When unset, the per-pair actors
   * resolve `adapterForDomain(domain)` themselves.
   */
  adapter?: DomainAdapter;
  /**
   * GH-1595 — drop the per-invocation `BeadsCache` after a pair's write
   * (`adapter.push()` write-back). Plumbed into the constructed
   * `GhDomainAdapter` alongside `loadAllBeads`; missing on test paths that
   * inject an `adapter` directly.
   */
  invalidateBeadsCache?: () => void;
  /**
   * GH-296 / prx-lzw — the current bead-store dataset etag (dolt HEAD). Used to
   * short-circuit the bd→GH push leg when the store hasn't moved since the last
   * successful push. Default: read the served clone's dolt HEAD. Returns
   * undefined when unknown ⇒ the push always runs (no false skip).
   */
  beadsHead?: (() => string | undefined) | undefined;
  /**
   * GH-296 / prx-lzw — the persisted "last successfully pushed HEAD" watermark
   * for this `(repo, domain)`. Default: a per-key file under
   * `~/.local/state/prx/sync`. Tests inject an in-memory one.
   */
  pushWatermark?: PushWatermark | undefined;
};

// ── summary shape ──────────────────────────────────────────────────────────

export type BeadsSyncSummary = {
  repo: string;
  domain: string;
  /** Total bd records scanned. */
  scanned: number;
  /** Records pinned to `domain` (have an `externalRef` this domain recognises). */
  pinned: number;
  /** Records *not* pinned to `domain` — counted, never touched. */
  skipped: number;
  /** Pairs whose pull leg completed this tick. */
  pulled: number;
  /** Pairs whose push leg completed this tick (planned-only on `--dry-run`). */
  pushed: number;
  /** Pairs whose external record resolved CLOSED while the bead was still open. */
  closedByPull: number;
  /** Pinned pairs that errored this tick (pull + push fail combined, back-compat). */
  failed: number;
  /** GH-2095 — pairs whose pull leg threw a non-budget error. */
  pullFailed: number;
  /**
   * GH-2095 — pairs the pull phase didn't reach this tick (mid-loop budget
   * cutoff). These are also pull-uncovered, so close-apply never ran for them.
   */
  pullDeferred: number;
  /**
   * GH-2095 — pairs that completed pull (and close-apply if needed) but whose
   * push leg was capped by `--limit` or the push-phase budget gate.
   */
  pushDeferred: number;
  /**
   * Pinned pairs not fully reconciled this tick. Back-compat sum:
   * `pullDeferred + pushDeferred`.
   */
  deferred: number;
  /** True when the tick exited early because the GraphQL budget was below threshold. */
  budgetPaused: boolean;
  dryRun: boolean;
  durationMs: number;
};

// ── per-pair detail (powers the optional per-pair audit row + JSON output) ──

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

// ── helpers ────────────────────────────────────────────────────────────────

// GH-1469: exported so the `prx sync backfill` routine (src/sync/backfill.ts)
// reuses the same GraphQL-budget gate rather than re-deriving the threshold /
// remaining-bucket logic.
export const DEFAULT_BUDGET_THRESHOLD = 100;
/** Conservative per-tick pinned-pair cap when `--limit` is not given. */
import { DEFAULT_SYNC_LIMIT } from "./limits.ts";

export function resolveThreshold(opt: number | undefined): number {
  if (typeof opt === "number" && Number.isFinite(opt) && opt >= 0) return opt;
  const env = getEnv("PRX_GH_BUDGET_THRESHOLD");
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_BUDGET_THRESHOLD;
}

/**
 * Is this bead pinned to `domain`? Reads `bead.externalRefs` (the GH-1538
 * multi-domain pin map). A bead is pinned to a domain iff `externalRefs`
 * carries a non-empty string for that domain key. `loadAllBeads` populates
 * the GH slot from the legacy `external_ref` single-pin for back-compat —
 * production callers never see an unpopulated `externalRefs.gh` for a GH
 * record.
 */
function pinnedDomain(bead: BeadsRecord, domain: string): boolean {
  const value = bead.externalRefs[domain];
  return typeof value === "string" && value.length > 0;
}

/**
 * GraphQL-budget-exhaustion errors from the GH-1141 gated runner carry a
 * message of the form `gh graphql budget exhausted: …` / `gh core budget
 * exhausted: …` (`BucketBudgetExhaustedError`). A pair that failed with such a
 * message is a budget cutoff mid-call, not a real failure — reclassify it as
 * `deferred` and stop the loop.
 */
export function looksLikeBudgetExhaustion(message: string | undefined): boolean {
  return typeof message === "string" && /\bbudget exhausted\b/i.test(message);
}

export function graphqlRemaining(snapshots: ReturnType<typeof defaultRefreshBudget>): number | null {
  if (!snapshots) return null;
  const gql = snapshots.find((s) => s.bucket === "graphql");
  return gql ? gql.remaining : null;
}

type PairOutcome = DomainSyncPairContext & { state: string };

/** Spawn one `domainSyncMachine`, run it, and resolve with its final context + state. */
function runPairMachine(input: DomainSyncPairInput): Promise<PairOutcome> {
  const actor = createActor(domainSyncMachine, { input });
  return new Promise<PairOutcome>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      const snap = actor.getSnapshot();
      resolve({ ...snap.context, state: String(snap.value) });
    };
    actor.subscribe((s) => {
      if (s.status === "done") settle();
    });
    actor.start();
    if (actor.getSnapshot().status === "done") settle();
  });
}

// ── the tick ───────────────────────────────────────────────────────────────

export async function runBeadsSync(
  opts: RunBeadsSyncOptions,
  output: { log: (line: string) => void; error: (line: string) => void },
  deps: RunBeadsSyncDeps = {},
): Promise<BeadsSyncResult> {
  const nowFn = deps.now ?? (() => new Date());
  const startedAt = nowFn().getTime();
  const elapsedMs = () => Math.max(0, nowFn().getTime() - startedAt);
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const loadAllBeads = deps.loadAllBeads ?? defaultLoadAllBeads;
  const refreshBudget = deps.refreshBudget ?? defaultRefreshBudget;
  const repoNameWithOwner = deps.repoNameWithOwner ?? defaultRepoNameWithOwner;
  const appendAuditRow = deps.appendAuditRow ?? defaultAppendAuditRow;
  const getAuditRuntimeContext = deps.getAuditRuntimeContext ?? defaultGetAuditRuntimeContext;

  const domain = opts.domain;
  if (!registeredDomains().includes(domain)) {
    output.error(
      `beads sync: no registered adapter for domain '${domain}' (registered: ${registeredDomains().join(", ") || "<none>"})`,
    );
    return makeFailure(domain, elapsedMs());
  }

  let repo: string;
  try {
    repo = (opts.repo && opts.repo.trim().length > 0
      ? opts.repo.trim()
      : repoNameWithOwner(cwd).trim());
  } catch (err) {
    output.error(`beads sync: could not resolve OWNER/REPO: ${err instanceof Error ? err.message : String(err)}`);
    return makeFailure(domain, elapsedMs());
  }
  if (!repo) {
    output.error("beads sync: could not resolve OWNER/REPO from cwd");
    return makeFailure(domain, elapsedMs());
  }

  const threshold = resolveThreshold(opts.budget);
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_SYNC_LIMIT;

  // GH-296 / prx-lzw — push-leg short-circuit. The bead-store etag (dolt HEAD)
  // vs the last successfully-pushed watermark for this (repo, domain): when
  // unchanged, the bd→GH push leg has nothing to do and is skipped (saving its
  // GitHub write requests). The pull leg always runs (GH→bd is independent).
  const beadsHead = deps.beadsHead ?? (() => readDoltHead(cwd));
  const pushWatermark = deps.pushWatermark ?? createPushWatermark(`${repo}/${domain}`);

  const auditActor = getAuditRuntimeContext().actor;

  // ── budget gate (entry) ──────────────────────────────────────────────────
  const remainingAtEntry = graphqlRemaining(refreshBudget());
  if (remainingAtEntry !== null && remainingAtEntry < threshold) {
    const summary: BeadsSyncSummary = {
      repo, domain,
      scanned: 0, pinned: 0, skipped: 0,
      pulled: 0, pushed: 0, closedByPull: 0,
      failed: 0, pullFailed: 0,
      pullDeferred: 0, pushDeferred: 0, deferred: 0,
      budgetPaused: true, dryRun: opts.dryRun,
      durationMs: elapsedMs(),
    };
    appendAuditRow(makeSummaryRow(summary, auditActor, nowFn().toISOString()));
    output.log(renderSummary(summary, [], opts.format, { thresholdNote: `paused: GraphQL budget ${remainingAtEntry} < threshold ${threshold}` }));
    return { exitCode: 0, summary, pairs: [] };
  }

  // ── enumerate pinned pairs ───────────────────────────────────────────────
  let beads: BeadsRecord[];
  try {
    beads = loadAllBeads();
  } catch (err) {
    output.error(`beads sync: ${err instanceof Error ? err.message : String(err)}`);
    return makeFailure(domain, elapsedMs());
  }
  const scanned = beads.length;
  const pinnedBeads = beads
    .filter((b) => pinnedDomain(b, domain))
    .sort((a, b) => a.id.localeCompare(b.id));
  const skipped = scanned - pinnedBeads.length;

  // GH-1595: when `loadAllBeads` is wired through the CLI-entry `BeadsCache`,
  // construct a per-run adapter that shares the same cache (and invalidator)
  // so every `adapter.push` / `adapter.resolve` inside the bulk loop hits the
  // already-warmed read instead of dragging the multi-MB `bd list --all
  // --json` over the wire again per pair. When `deps.adapter` is injected
  // (test seam) or no cache is wired, fall back to the registered singleton.
  const adapter = deps.adapter
    ?? (domain === "gh" && deps.loadAllBeads
      ? new GhDomainAdapter({
          loadAllBeads: deps.loadAllBeads,
          invalidateBeadsCache: deps.invalidateBeadsCache,
        })
      : adapterForDomain(domain) ?? undefined);

  const pairs: BeadsSyncPairDetail[] = [];
  let pullFailed = 0;
  let pushFailed = 0;
  let pullDeferred = 0;
  let pushDeferred = 0;
  let budgetCutoff = false;

  // ── Phase 1: pull leg over EVERY pinned pair (I-DS3) ─────────────────────
  // The pull leg drives the close-apply decision and must not be gated by
  // `--limit` — that's how I-DS2 holds for pairs whose short ids would
  // otherwise sort past the slice. The only mid-loop cut is the GraphQL
  // budget gate; cut pairs count as `pullDeferred` (close-apply never sees
  // them this tick).
  type PulledPair = {
    bead: BeadsRecord;
    externalId: string;
    pullResult: DomainSyncPullResult;
  };
  const pulledPairs: PulledPair[] = [];

  for (let i = 0; i < pinnedBeads.length; i++) {
    const bead = pinnedBeads[i]!;
    // Re-check the budget before each pair after the first (the `gh api
    // rate_limit` probe bypasses the gate and does not count against it).
    if (i > 0) {
      const remaining = graphqlRemaining(refreshBudget());
      if (remaining !== null && remaining < threshold) {
        budgetCutoff = true;
        pullDeferred += pinnedBeads.length - i;
        break;
      }
    }

    const externalId = (bead.externalRefs[domain] ?? bead.externalRef ?? "").trim();
    const ctx = await runPairMachine({
      bead,
      domain,
      externalId,
      dryRun: opts.dryRun,
      adapter,
      pushAllowed: false,
    });

    if (ctx.state === "failed") {
      const message = ctx.blockedReason?.message ?? "unknown failure";
      if (looksLikeBudgetExhaustion(message)) {
        // Mid-call budget cutoff — not a real failure. This pair + the rest
        // are deferred to the next tick.
        budgetCutoff = true;
        pullDeferred += pinnedBeads.length - i;
        break;
      }
      pullFailed += 1;
      pairs.push({
        beadId: bead.id,
        externalId,
        externalStatus: "unknown",
        closedByPull: false,
        pushed: false,
        action: "failed",
        message,
      });
      continue;
    }

    if (ctx.pullResult) {
      pulledPairs.push({ bead, externalId, pullResult: ctx.pullResult });
    }
  }

  const pulled = pulledPairs.length;
  const closedByPull = pulledPairs.filter((p) => p.pullResult.needsClose).length;

  // ── Phase 2: batched close-apply (pull leg) ──────────────────────────────
  // Close every bead whose external record is CLOSED across the FULL pulled
  // set — never the limit slice (I-DS2). Dispatch order:
  //   1. `deps.bulkClose` — test seam (`I-DS2` suite injects directly).
  //   2. `adapter.bulkClose({ cwd, beadIds })` — per-domain close-apply. GH
  //      (GH-2011) loops `execBdIssueClose` per id; Notion loops
  //      `bd update <id> --status closed` per id.
  // Skipped on `--dry-run` and when no pair needed closing.
  const beadIdsToClose = pulledPairs
    .filter((p) => p.pullResult.needsClose)
    .map((p) => p.bead.id);
  let bulkCloseExitCode: number | null = null;
  if (beadIdsToClose.length > 0 && !opts.dryRun) {
    const result = deps.bulkClose
      ? deps.bulkClose(cwd, false)
      : adapter?.bulkClose
        ? adapter.bulkClose({ cwd, beadIds: beadIdsToClose })
        : { exitCode: 0, stdout: "", stderr: "" };
    bulkCloseExitCode = result.exitCode;
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || "close-apply failed";
      output.error(`beads sync: WARN close-apply exited ${result.exitCode}: ${detail}`);
    }
  }

  // ── Phase 3: push leg, capped at `--limit` ───────────────────────────────
  // Re-sort so close-applied pairs land at the tail: pushing title/body to
  // an already-closed issue is lower-value than reconciling a live one, and
  // when the limit cut bites the higher-value writes are the ones that fire.
  const sortedForPush: PulledPair[] = [
    ...pulledPairs.filter((p) => !p.pullResult.needsClose),
    ...pulledPairs.filter((p) => p.pullResult.needsClose),
  ];
  // GH-296 / prx-lzw — skip the whole push leg when the bead store is unchanged
  // since the last successful push (nothing bd-authoritative to write). Never on
  // --dry-run (that's a planning preview). A skip is not a deferral: 0 deferred.
  const currentHead = beadsHead();
  const lastPushed = pushWatermark.read();
  const pushSkipped = !opts.dryRun && shouldSkipPush(currentHead, lastPushed);
  if (pushSkipped) {
    // Diagnostic (stderr) — stdout is reserved for the rendered summary (JSON-safe).
    output.error(
      `beads sync: push leg skipped — bead store unchanged since last successful push (HEAD=${currentHead})`,
    );
  }
  const toPush = pushSkipped ? [] : sortedForPush.slice(0, limit);
  pushDeferred = pushSkipped ? 0 : sortedForPush.length - toPush.length;
  const pushedBeadIds = new Set<string>();
  let pushed = 0;

  for (let i = 0; i < toPush.length; i++) {
    const { bead, externalId, pullResult } = toPush[i]!;
    if (i > 0) {
      const remaining = graphqlRemaining(refreshBudget());
      if (remaining !== null && remaining < threshold) {
        budgetCutoff = true;
        pushDeferred += toPush.length - i;
        break;
      }
    }

    const ctx = await runPairMachine({
      bead,
      domain,
      externalId,
      dryRun: opts.dryRun,
      adapter,
      pushAllowed: true,
      prefilledPullResult: pullResult,
    });

    if (ctx.state === "failed") {
      const message = ctx.blockedReason?.message ?? "unknown failure";
      if (looksLikeBudgetExhaustion(message)) {
        budgetCutoff = true;
        pushDeferred += toPush.length - i;
        break;
      }
      pushFailed += 1;
      pairs.push({
        beadId: bead.id,
        externalId,
        externalStatus: pullResult.externalStatus,
        closedByPull: pullResult.needsClose,
        pushed: false,
        action: "failed",
        message,
      });
      continue;
    }

    const didPush = ctx.pushResult?.edited ?? false;
    if (didPush) pushed += 1;
    const needsClose = pullResult.needsClose;
    if (needsClose || didPush) {
      pairs.push({
        beadId: bead.id,
        externalId,
        externalStatus: pullResult.externalStatus,
        closedByPull: needsClose,
        pushed: didPush,
        action: "synced",
      });
      pushedBeadIds.add(bead.id);
    }
  }

  // ── Phase 3.5: synced rows for close-applied pairs that didn't reach push ─
  // A pair that pull-flagged `needsClose` is part of the close-apply set
  // regardless of whether its push leg fired this tick — record a synced
  // row so the audit/JSON output reflects the close even when the push is
  // limit- or budget-deferred.
  for (const { bead, externalId, pullResult } of pulledPairs) {
    if (!pullResult.needsClose) continue;
    if (pushedBeadIds.has(bead.id)) continue;
    pairs.push({
      beadId: bead.id,
      externalId,
      externalStatus: pullResult.externalStatus,
      closedByPull: true,
      pushed: false,
      action: "synced",
    });
  }

  // GH-296 / prx-lzw — advance the push watermark only on a fully-successful
  // push (no deferrals, no errors); retry-safe (a partial/failed push keeps the
  // old watermark so the next tick re-attempts). Skipped + dry-run never persist.
  if (!pushSkipped && !opts.dryRun) {
    const next = advanceLastPushedHead({
      previous: lastPushed,
      currentHead,
      outcome: { pushDeferred, pushErrors: pushFailed },
    });
    if (next !== undefined && next !== lastPushed) pushWatermark.write(next);
  }

  const failed = pullFailed + pushFailed;
  const deferred = pullDeferred + pushDeferred;

  const summary: BeadsSyncSummary = {
    repo, domain,
    scanned, pinned: pinnedBeads.length, skipped,
    pulled, pushed, closedByPull,
    failed, pullFailed,
    pullDeferred, pushDeferred, deferred,
    budgetPaused: false, dryRun: opts.dryRun,
    durationMs: elapsedMs(),
  };

  // ── audit rows ───────────────────────────────────────────────────────────
  const ts = nowFn().toISOString();
  appendAuditRow(makeSummaryRow(summary, auditActor, ts));
  for (const pair of pairs) {
    appendAuditRow(makePairRow(pair, repo, domain, auditActor, opts.dryRun, ts));
  }

  output.log(
    renderSummary(summary, pairs, opts.format, {
      budgetCutoffNote: budgetCutoff ? "stopped early: GraphQL budget fell below threshold" : undefined,
      bulkCloseExitCode,
    }),
  );

  // GH-2095 — WARN + exit code 2 when the tick left pinned pairs un-reconciled.
  // Hard errors (repo unresolvable, etc.) keep their existing exit 1 via
  // `makeFailure`; per-pair failures still don't bump exit (they retry next
  // tick). Deferred pairs are operator-actionable: re-run, raise `--limit`,
  // or wait for the next budget window.
  let exitCode = 0;
  if (pullDeferred + pushDeferred > 0) {
    const total = pullDeferred + pushDeferred;
    output.error(
      `beads sync: WARN ${total} pinned pair${total === 1 ? "" : "s"} were not fully reconciled this tick`,
    );
    output.error(
      `  pull-deferred: ${pullDeferred}  push-deferred: ${pushDeferred}`,
    );
    output.error(
      `  re-run, or pass --limit=${pinnedBeads.length} to drain in one tick`,
    );
    exitCode = 2;
  }

  return { exitCode, summary, pairs };
}

// ── audit-row builders ─────────────────────────────────────────────────────

function makeSummaryRow(s: BeadsSyncSummary, actor: string, ts: string) {
  return {
    ts,
    kind: "domain-sync-run" as const,
    repo: s.repo,
    domain: s.domain,
    scanned: s.scanned,
    pinned: s.pinned,
    skipped: s.skipped,
    pulled: s.pulled,
    pushed: s.pushed,
    closedByPull: s.closedByPull,
    failed: s.failed,
    pullFailed: s.pullFailed,
    pullDeferred: s.pullDeferred,
    pushDeferred: s.pushDeferred,
    deferred: s.deferred,
    budgetPaused: s.budgetPaused,
    dryRun: s.dryRun,
    durationMs: s.durationMs,
    actor,
  };
}

function makePairRow(p: BeadsSyncPairDetail, repo: string, domain: string, actor: string, dryRun: boolean, ts: string) {
  return {
    ts,
    kind: "domain-sync-pair" as const,
    repo,
    domain,
    beadId: p.beadId,
    externalId: p.externalId,
    externalStatus: p.externalStatus,
    closedByPull: p.closedByPull,
    pushed: p.pushed,
    action: p.action,
    ...(p.message ? { message: p.message } : {}),
    dryRun,
    actor,
  };
}

// ── rendering ──────────────────────────────────────────────────────────────

function renderSummary(
  s: BeadsSyncSummary,
  pairs: BeadsSyncPairDetail[],
  format: "plain" | "json",
  extra: { thresholdNote?: string | undefined; budgetCutoffNote?: string | undefined; bulkCloseExitCode?: number | null | undefined } = {},
): string {
  if (format === "json") {
    return JSON.stringify({ ...s, pairs, ...extra }, null, 2);
  }
  const lines: string[] = [];
  lines.push(`beads sync — ${s.repo} (${s.domain})${s.dryRun ? " [dry-run]" : ""}`);
  if (s.budgetPaused) {
    lines.push(`  ${extra.thresholdNote ?? "paused: GraphQL budget below threshold"}`);
    return lines.join("\n");
  }
  lines.push(`  scanned ${s.scanned}  pinned ${s.pinned}  skipped ${s.skipped}`);
  lines.push(`  pulled ${s.pulled}  pushed ${s.pushed}  closedByPull ${s.closedByPull}  failed ${s.failed}  deferred ${s.deferred}`);
  lines.push(`  pullDeferred ${s.pullDeferred}  pushDeferred ${s.pushDeferred}`);
  if (extra.budgetCutoffNote) lines.push(`  ${extra.budgetCutoffNote}`);
  if (typeof extra.bulkCloseExitCode === "number") {
    lines.push(`  close-apply exit ${extra.bulkCloseExitCode}`);
  }
  for (const p of pairs) {
    const tag = p.action === "failed" ? "FAIL" : p.closedByPull ? "close+push" : "push";
    lines.push(`  ${tag} ${p.beadId} ${p.externalId}${p.message ? ` — ${p.message}` : ""}`);
  }
  lines.push(`  ${s.durationMs}ms`);
  return lines.join("\n");
}

function makeFailure(domain: string, durationMs: number): BeadsSyncResult {
  const summary: BeadsSyncSummary = {
    repo: "", domain,
    scanned: 0, pinned: 0, skipped: 0,
    pulled: 0, pushed: 0, closedByPull: 0,
    failed: 0, pullFailed: 0,
    pullDeferred: 0, pushDeferred: 0, deferred: 0,
    budgetPaused: false, dryRun: false,
    durationMs,
  };
  return { exitCode: 1, summary, pairs: [] };
}
