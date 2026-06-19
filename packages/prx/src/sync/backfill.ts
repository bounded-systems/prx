// `prx sync backfill` runtime (GH-1469) — range-backfill of external records
// the forward-only `bd github sync` cursor skipped without importing (the
// GH-1462 incident: 9 of 14 issues lost while present on GH). The GH-1500
// authority ADR §5 backfill verb: enumerate external records over a number
// range, resolve each to its bd counterpart via the `(domain, external_id)`
// map, and mirror the unmatched ones through the canonical single-record
// path.
//
// This is the operator-layer paper-over; the substrate resolver fix is
// GH-1479 (open, upstream gastownhall/beads). GH-1473 only contained it
// prx-side.
//
// Not to be confused with:
//   - `runBeadsSync` (src/sync/run.ts) — reconciles *already-pinned* pairs.
//   - `prx fetch gh-issues` (src/fetch/) — the watermark-advancing forward
//     sync. Backfill heals records the watermark already passed and MUST NOT
//     advance it (I-BF3; ADR §5 "no cursor advance").
//
// Source-of-truth seams reused (no reimplementation):
//   - `adapter.enumerate({from,to})` — the GH-1469 discovery seam.
//   - `adapter.resolveFromBeads` — URL/issue-number map match, never short-id
//     prefix (I-BF1).
//   - `runIntakeMirror` — the idempotent, race-checked single-record create
//     (I-BF2). Backfill *wraps* it; it is the single source of truth for
//     "create a bd record from an external record."
//   - `refreshBudget()` + `graphqlRemaining()`/`resolveThreshold()` (run.ts) —
//     the GraphQL budget gate (I-BF5).

import "../adapters/index.ts";
import {
  GhDomainAdapter,
  adapterForDomain,
  registeredDomains,
  type DomainAdapter,
} from "../adapters/index.ts";
import { appendAuditRow as defaultAppendAuditRow } from "../audit/sink.ts";
import { getAuditRuntimeContext as defaultGetAuditRuntimeContext } from "@bounded-systems/audit-context";
import { refreshBudget as defaultRefreshBudget } from "@bounded-systems/github-budget";
import { repoNameWithOwner as defaultRepoNameWithOwner } from "../pr-state/github.ts";
import { loadAllBeads as defaultLoadAllBeads, type BeadsRecord } from "../triage/triage.ts";
import {
  runIntakeMirror as defaultRunIntakeMirror,
  type IntakeMirrorRender,
} from "../intake/intake-mirror.ts";
import { graphqlRemaining, resolveThreshold } from "./run.ts";
import type { BackfillRecordDetail, BackfillSummary } from "./schemas.ts";

// ── options + deps ───────────────────────────────────────────────────────

export type RunBackfillOptions = {
  /** OWNER/REPO. Defaults to `repoNameWithOwner(cwd)`. */
  repo?: string | undefined;
  /** Domain to backfill; must be a registered `DomainAdapter` (currently `gh`). */
  domain: string;
  /** Inclusive issue-number range start. */
  from: number;
  /** Inclusive issue-number range end. */
  to: number;
  /** Plan only — no bd/gh writes (I-BF4). */
  dryRun: boolean;
  /** GraphQL-budget pause threshold; default `PRX_GH_BUDGET_THRESHOLD` ?? 100. */
  budget?: number | undefined;
  format: "plain" | "json";
};

export type RunBackfillDeps = {
  cwd?: () => string;
  loadAllBeads?: typeof defaultLoadAllBeads;
  refreshBudget?: typeof defaultRefreshBudget;
  repoNameWithOwner?: (path: string) => string;
  appendAuditRow?: typeof defaultAppendAuditRow;
  getAuditRuntimeContext?: typeof defaultGetAuditRuntimeContext;
  now?: () => Date;
  /** Override the domain adapter (test seam). */
  adapter?: DomainAdapter;
  /** Override the single-record mirror (test seam). */
  runIntakeMirror?: typeof defaultRunIntakeMirror;
  /** GH-1595 — drop the per-invocation `BeadsCache` after a write-back. */
  invalidateBeadsCache?: () => void;
};

export type BackfillResult = {
  exitCode: number;
  summary: BackfillSummary;
  records: BackfillRecordDetail[];
};

type Output = { log: (line: string) => void; error: (line: string) => void };

// ── the run ─────────────────────────────────────────────────────────────

export async function runBackfill(
  opts: RunBackfillOptions,
  output: Output,
  deps: RunBackfillDeps = {},
): Promise<BackfillResult> {
  const nowFn = deps.now ?? (() => new Date());
  const startedAt = nowFn().getTime();
  const elapsedMs = () => Math.max(0, nowFn().getTime() - startedAt);
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const loadAllBeads = deps.loadAllBeads ?? defaultLoadAllBeads;
  const refreshBudget = deps.refreshBudget ?? defaultRefreshBudget;
  const repoNameWithOwner = deps.repoNameWithOwner ?? defaultRepoNameWithOwner;
  const appendAuditRow = deps.appendAuditRow ?? defaultAppendAuditRow;
  const getAuditRuntimeContext = deps.getAuditRuntimeContext ?? defaultGetAuditRuntimeContext;
  const runIntakeMirror = deps.runIntakeMirror ?? defaultRunIntakeMirror;

  const domain = opts.domain;
  const from = Math.min(opts.from, opts.to);
  const to = Math.max(opts.from, opts.to);

  if (!registeredDomains().includes(domain)) {
    output.error(
      `sync backfill: no registered adapter for domain '${domain}' (registered: ${registeredDomains().join(", ") || "<none>"})`,
    );
    return makeFailure(domain, from, to, elapsedMs());
  }

  let repo: string;
  try {
    repo =
      opts.repo && opts.repo.trim().length > 0 ? opts.repo.trim() : repoNameWithOwner(cwd).trim();
  } catch (err) {
    output.error(
      `sync backfill: could not resolve OWNER/REPO: ${err instanceof Error ? err.message : String(err)}`,
    );
    return makeFailure(domain, from, to, elapsedMs());
  }
  if (!repo) {
    output.error("sync backfill: could not resolve OWNER/REPO from cwd");
    return makeFailure(domain, from, to, elapsedMs());
  }

  const threshold = resolveThreshold(opts.budget);
  const auditActor = getAuditRuntimeContext().actor;
  const runUowId = `backfill:${domain}:${from}-${to}`;

  // ── budget gate (entry) — I-BF5 ──────────────────────────────────────────
  const remainingAtEntry = graphqlRemaining(refreshBudget());
  if (remainingAtEntry !== null && remainingAtEntry < threshold) {
    const summary = makeSummary(repo, domain, from, to, opts.dryRun, elapsedMs(), {
      budgetPaused: true,
    });
    appendAuditRow(makeRunRow(summary, runUowId, auditActor, nowFn().toISOString()));
    output.log(
      renderSummary(summary, [], opts.format, {
        thresholdNote: `paused: GraphQL budget ${remainingAtEntry} < threshold ${threshold}`,
      }),
    );
    return { exitCode: 0, summary, records: [] };
  }

  // Load the bd snapshot once for resolve (I-BF1) and inject the cached loader
  // into `runIntakeMirror` so its per-record dedup hits the warm read.
  let beads: BeadsRecord[];
  try {
    beads = loadAllBeads();
  } catch (err) {
    output.error(`sync backfill: ${err instanceof Error ? err.message : String(err)}`);
    return makeFailure(domain, from, to, elapsedMs());
  }
  const cachedLoader: typeof defaultLoadAllBeads = () => beads;

  // The adapter resolves itself unless a test seam injects one. The cache-backed
  // gh adapter shares the warmed read with `resolveFromBeads` below.
  const adapter =
    deps.adapter ??
    (domain === "gh"
      ? new GhDomainAdapter({
          loadAllBeads: cachedLoader,
          invalidateBeadsCache: deps.invalidateBeadsCache,
        })
      : (adapterForDomain(domain) ?? undefined));
  if (!adapter) {
    output.error(`sync backfill: no adapter for domain '${domain}'`);
    return makeFailure(domain, from, to, elapsedMs());
  }

  // ── enumerate (read-only; never advances watermark/cursor — I-BF3) ───────
  let refs: Awaited<ReturnType<DomainAdapter["enumerate"]>>;
  try {
    refs = await adapter.enumerate({ from, to }, { cwd });
  } catch (err) {
    output.error(`sync backfill: ${err instanceof Error ? err.message : String(err)}`);
    return makeFailure(domain, from, to, elapsedMs());
  }

  const records: BackfillRecordDetail[] = [];
  let mirrored = 0;
  let skipped = 0;
  let failed = 0;
  let deferred = 0;
  let budgetCutoff = false;

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]!;
    // Re-check budget before each record after the first (I-BF5). The
    // `gh api rate_limit` probe bypasses the gate and does not count.
    if (i > 0) {
      const remaining = graphqlRemaining(refreshBudget());
      if (remaining !== null && remaining < threshold) {
        budgetCutoff = true;
        deferred += refs.length - i;
        break;
      }
    }

    // I-BF1 — resolve via the (domain, external_id) map, never short-id prefix.
    const resolved = adapter.resolveFromBeads(ref.externalId, beads);
    if (resolved) {
      skipped += 1;
      const detail: BackfillRecordDetail = {
        externalId: ref.externalId,
        surfaceId: ref.surfaceId,
        action: "skipped",
        bdId: resolved,
      };
      records.push(detail);
      appendAuditRow(
        makeRecordRow(detail, repo, domain, opts.dryRun, auditActor, nowFn().toISOString()),
      );
      continue;
    }

    // Unmatched → mirror through the canonical single-record path (I-BF2).
    // Capture its output as JSON so the created/existing bd id is structured.
    const captured: string[] = [];
    const capOut: Output = {
      log: (l) => captured.push(l),
      error: (l) => captured.push(l),
    };
    const exit = runIntakeMirror(
      { ghId: ref.surfaceId, repo, dryRun: opts.dryRun, format: "json" },
      capOut,
      { loadAllBeads: cachedLoader },
    );
    if (exit !== 0) {
      failed += 1;
      const message = captured.join(" ").trim() || "mirror failed";
      const detail: BackfillRecordDetail = {
        externalId: ref.externalId,
        surfaceId: ref.surfaceId,
        action: "failed",
        message,
      };
      records.push(detail);
      appendAuditRow(
        makeRecordRow(detail, repo, domain, opts.dryRun, auditActor, nowFn().toISOString()),
      );
      continue;
    }

    const render = parseMirrorRender(captured);
    // A race that created the record between our resolve and the mirror lands
    // as `existingBdId` — count it as skipped so re-running stays a zero-net
    // no-op (I-BF2). A real create (or a dry-run plan) counts as mirrored.
    if (render?.existingBdId && !render.createdBdId && !opts.dryRun) {
      skipped += 1;
      const detail: BackfillRecordDetail = {
        externalId: ref.externalId,
        surfaceId: ref.surfaceId,
        action: "skipped",
        bdId: render.existingBdId,
      };
      records.push(detail);
      appendAuditRow(
        makeRecordRow(detail, repo, domain, opts.dryRun, auditActor, nowFn().toISOString()),
      );
      continue;
    }

    mirrored += 1;
    const detail: BackfillRecordDetail = {
      externalId: ref.externalId,
      surfaceId: ref.surfaceId,
      action: "mirrored",
      ...(render?.createdBdId ? { bdId: render.createdBdId } : {}),
    };
    records.push(detail);
    appendAuditRow(
      makeRecordRow(detail, repo, domain, opts.dryRun, auditActor, nowFn().toISOString()),
    );
  }

  const summary = makeSummary(repo, domain, from, to, opts.dryRun, elapsedMs(), {
    scanned: refs.length,
    mirrored,
    skipped,
    failed,
    deferred,
  });

  const ts = nowFn().toISOString();
  appendAuditRow(makeRunRow(summary, runUowId, auditActor, ts));

  output.log(
    renderSummary(summary, records, opts.format, {
      budgetCutoffNote: budgetCutoff
        ? "stopped early: GraphQL budget fell below threshold"
        : undefined,
    }),
  );

  // Deferred records are operator-actionable (re-run / wait for budget window):
  // exit 2 + WARN, mirroring `runBeadsSync`. Per-record failures retry on the
  // next run and do not bump the exit code.
  let exitCode = 0;
  if (deferred > 0) {
    output.error(
      `sync backfill: WARN ${deferred} record${deferred === 1 ? "" : "s"} were not reached this run (GraphQL budget)`,
    );
    output.error("  re-run to drain the remainder, or wait for the next budget window");
    exitCode = 2;
  }

  return { exitCode, summary, records };
}

// ── helpers ───────────────────────────────────────────────────────────────

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

function makeSummary(
  repo: string,
  domain: string,
  from: number,
  to: number,
  dryRun: boolean,
  durationMs: number,
  over: Partial<
    Pick<
      BackfillSummary,
      "scanned" | "mirrored" | "skipped" | "failed" | "deferred" | "budgetPaused"
    >
  > = {},
): BackfillSummary {
  return {
    repo,
    domain,
    from,
    to,
    scanned: over.scanned ?? 0,
    mirrored: over.mirrored ?? 0,
    skipped: over.skipped ?? 0,
    failed: over.failed ?? 0,
    deferred: over.deferred ?? 0,
    budgetPaused: over.budgetPaused ?? false,
    dryRun,
    durationMs,
  };
}

function makeFailure(domain: string, from: number, to: number, durationMs: number): BackfillResult {
  const summary = makeSummary("", domain, from, to, false, durationMs);
  return { exitCode: 1, summary, records: [] };
}

function makeRunRow(s: BackfillSummary, uowId: string, actor: string, ts: string) {
  return {
    ts,
    kind: "domain-sync-backfill-run" as const,
    repo: s.repo,
    domain: s.domain,
    from: s.from,
    to: s.to,
    scanned: s.scanned,
    mirrored: s.mirrored,
    skipped: s.skipped,
    failed: s.failed,
    deferred: s.deferred,
    budgetPaused: s.budgetPaused,
    dryRun: s.dryRun,
    durationMs: s.durationMs,
    uow_id: uowId,
    actor,
  };
}

function makeRecordRow(
  r: BackfillRecordDetail,
  repo: string,
  domain: string,
  dryRun: boolean,
  actor: string,
  ts: string,
) {
  return {
    ts,
    kind: "domain-sync-backfill-record" as const,
    repo,
    domain,
    externalId: r.externalId,
    surfaceId: r.surfaceId,
    action: r.action,
    ...(r.bdId ? { bdId: r.bdId } : {}),
    ...(r.message ? { message: r.message } : {}),
    dryRun,
    uow_id: r.surfaceId,
    actor,
  };
}

function renderSummary(
  s: BackfillSummary,
  records: BackfillRecordDetail[],
  format: "plain" | "json",
  extra: { thresholdNote?: string | undefined; budgetCutoffNote?: string | undefined } = {},
): string {
  if (format === "json") {
    return JSON.stringify({ ...s, records, ...extra }, null, 2);
  }
  const lines: string[] = [];
  lines.push(
    `sync backfill — ${s.repo} (${s.domain}) #${s.from}..#${s.to}${s.dryRun ? " [dry-run]" : ""}`,
  );
  if (s.budgetPaused) {
    lines.push(`  ${extra.thresholdNote ?? "paused: GraphQL budget below threshold"}`);
    return lines.join("\n");
  }
  lines.push(
    `  scanned ${s.scanned}  mirrored ${s.mirrored}  skipped ${s.skipped}  failed ${s.failed}  deferred ${s.deferred}`,
  );
  if (extra.budgetCutoffNote) lines.push(`  ${extra.budgetCutoffNote}`);
  for (const r of records) {
    const tag = r.action === "failed" ? "FAIL" : r.action === "skipped" ? "skip" : "mirror";
    const idNote = r.bdId ? ` → ${r.bdId}` : "";
    lines.push(`  ${tag} ${r.surfaceId}${idNote}${r.message ? ` — ${r.message}` : ""}`);
  }
  lines.push(`  ${s.durationMs}ms`);
  return lines.join("\n");
}
