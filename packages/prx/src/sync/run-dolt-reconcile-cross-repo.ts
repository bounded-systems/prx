// GH-1702 — cross-repo `prx beads sync-all` orchestrator.
//
// Walks `.prx/repos/index.json` and fans `runDoltReconcile()` out across every
// indexed bare repo whose inventory carries a `dolt_remote` AND whose on-disk
// `.beads/` shape is reconcile-ready (per-project or shared-server). Sibling
// of `runBeadsSyncAcrossRepos` (GH-1662) with three structural differences:
//
//   1. No cursor. Per-repo `dolt push`/`pull` is not GitHub-API-budget-bound,
//      so the GH-1662 cursor pattern is unneeded — every tick walks the full
//      candidate list top-to-bottom.
//   2. No materialize seam. `runDoltReconcile` operates on the bare directly
//      via `cwd: repo.barePath`; there is no worktree-materialize step.
//   3. The eligibility filter (`listIndexedReposForDoltReconcile`) emits
//      both `eligible` and `skipped` arms in a single walk; the orchestrator
//      surfaces skips in the per-repo result table rather than dropping them
//      silently.
//
// Workflow-model alignment (`prx actors --scope workflow`):
//   - Actor: `dolt` (GH-2009). Six new emits added (GH-1702):
//     DOLT_SYNC_ALL_STARTED, DOLT_SYNC_REPO_STARTED,
//     DOLT_SYNC_REPO_RECONCILED, DOLT_SYNC_REPO_SKIPPED,
//     DOLT_SYNC_REPO_FAILED, DOLT_SYNC_ALL_COMPLETED.
//   - The catalog declares `dolt sync-all` (GH-2009 forward registration);
//     GH-1702 lands the verb under its original issue-spec name
//     (`prx beads sync-all`).
//
// Invariants:
//   - I-DR-SA1 (dry-run no writes). `--dry-run` produces zero `bd dolt
//     commit|pull|push` spawns and zero filesystem writes. The reconcile
//     primitive already enforces `--dry-run`; the fan-out threads it through.
//   - I-DR-SA2 (per-repo isolation). A per-repo failure does not abort the
//     walk; failure is captured as `DOLT_SYNC_REPO_FAILED` and the walk
//     proceeds. Exit code is non-zero iff any per-repo pass failed
//     (status === "failed") or hit a schema conflict (status === "conflict").
//   - I-DR-SA3 (slug-resolution authority). When `--repo <slug>` is set, the
//     candidate set is the resolved-and-gated singleton; the invocation cwd
//     is never used as a fallback. The CLI layer is responsible for the
//     slug → inventory entry resolution before calling the orchestrator;
//     this file accepts the pre-filtered candidate list via
//     `opts.candidates` so the regression-guard contract is enforced at the
//     CLI boundary (see GH-1697 anti-pattern note in the plan).
//   - I-DR-SA4 (eligibility-filter direction). Skips are reported as
//     `DOLT_SYNC_REPO_SKIPPED` with an explicit reason, not silently dropped.

import {
  loadRepoInventoryConfig,
  loadRepoInventoryIndex,
  listIndexedReposForDoltReconcile,
  type BeadsStateForReconcile,
  type DoltReconcileCandidate,
  type RepoRunner,
} from "../pr-state/repos.ts";
import {
  runDoltReconcileWithResult,
  type DoltReconcileMode,
  type DoltReconcileResolveMode,
  type DoltReconcileResult,
  type DoltReconcileStep,
} from "../pr-state/dolt-reconcile.ts";
import { classifyBeadsWorkspace, type BeadsWorkspaceMode } from "../beads/workspace_mode.ts";
import { appendAuditRow as defaultAppendAuditRow } from "../audit/sink.ts";
import { getAuditRuntimeContext as defaultGetAuditRuntimeContext } from "@bounded-systems/audit-context";
import {
  doltReconcileAcrossReposResultSchema,
  doltReconcileRepoResultSchema,
  type DoltReconcileAcrossReposResult,
  type DoltReconcileRepoResult,
} from "./schemas.ts";

export type RunDoltReconcileAcrossReposOptions = {
  mode: DoltReconcileMode;
  dryRun: boolean;
  format: "plain" | "json";
  resolve?: DoltReconcileResolveMode;
  /**
   * When provided, the orchestrator runs over exactly this candidate set
   * (CLI-resolved single-repo case). When omitted, the orchestrator loads
   * the inventory and walks every eligible/skipped row.
   */
  candidates?: DoltReconcileCandidate[];
};

export type RunDoltReconcileAcrossReposDeps = {
  cwd?: () => string;
  /** Inventory-loader seam — tests inject the candidate list directly. */
  loadCandidates?: (cwd: string) => DoltReconcileCandidate[] | null;
  /** Beads-state classifier seam — production uses `classifyBeadsWorkspace`. */
  classifyBeadsState?: (barePath: string) => BeadsStateForReconcile;
  /** Per-repo reconcile-primitive seam — tests inject a fake. */
  runDoltReconcile?: typeof runDoltReconcileWithResult;
  /** Audit-sink seam. */
  appendAuditRow?: typeof defaultAppendAuditRow;
  /** Runtime-context seam (provides `actor` for audit rows). */
  getAuditRuntimeContext?: typeof defaultGetAuditRuntimeContext;
  /** Clock seam (tickStartedAt + audit row ts). */
  now?: () => Date;
  /** Repo-runner seam used by `loadRepoInventoryConfig`. */
  runner?: RepoRunner;
};

type Output = { log: (line: string) => void; error: (line: string) => void };

function defaultLoadCandidates(
  cwd: string,
  classifyBeadsState: (barePath: string) => BeadsStateForReconcile,
  runner?: RepoRunner,
): DoltReconcileCandidate[] | null {
  const config = loadRepoInventoryConfig(cwd, runner);
  if (!config.indexPath) return null;
  const inventory = loadRepoInventoryIndex(config.indexPath);
  if (!inventory) return null;
  return listIndexedReposForDoltReconcile(inventory, classifyBeadsState);
}

// Map the live `BeadsWorkspaceMode.kind` onto the
// `BeadsStateForReconcile` shape the filter expects. The filter treats every
// non-{per_project,shared_server} state as `legacy-embedded` conservatively,
// so the mapping is lossless for the eligibility decision.
function defaultClassifyBeadsState(barePath: string): BeadsStateForReconcile {
  const mode: BeadsWorkspaceMode = classifyBeadsWorkspace(barePath);
  return mode.kind;
}

function mapStep(s: DoltReconcileStep): {
  step: DoltReconcileStep["step"];
  status: DoltReconcileStep["status"];
  exitCode: number;
  command: string;
  stderrTail?: string;
} {
  const step: {
    step: DoltReconcileStep["step"];
    status: DoltReconcileStep["status"];
    exitCode: number;
    command: string;
    stderrTail?: string;
  } = {
    step: s.step,
    status: s.status,
    exitCode: s.exitCode,
    command: s.command,
  };
  if (s.stderrTail !== undefined) step.stderrTail = s.stderrTail;
  return step;
}

function classifyReconcile(result: DoltReconcileResult): {
  status: DoltReconcileRepoResult["status"];
  hint?: string;
  error?: string;
} {
  switch (result.state) {
    case "reconciled": {
      // `no-op` iff the executed pipeline ran no work — every step either
      // `skipped` (commit: nothing to commit) or this is a dry-run preview.
      // Otherwise: `success`.
      const allSkipped =
        result.steps.length > 0 && result.steps.every((s) => s.status === "skipped");
      const out: { status: DoltReconcileRepoResult["status"]; hint?: string; error?: string } = {
        status: allSkipped ? "no-op" : "success",
      };
      if (result.hint) out.hint = result.hint;
      return out;
    }
    case "preview": {
      const out: { status: DoltReconcileRepoResult["status"]; hint?: string } = {
        status: "success",
      };
      if (result.hint) out.hint = result.hint;
      return out;
    }
    case "schemaConflictPending": {
      const out: { status: DoltReconcileRepoResult["status"]; hint?: string } = {
        status: "conflict",
      };
      if (result.hint) out.hint = result.hint;
      return out;
    }
    case "stuck": {
      const message = result.hint ?? "dolt reconcile stuck";
      return { status: "failed", hint: message, error: message };
    }
  }
}

function renderTable(
  result: DoltReconcileAcrossReposResult,
  candidateCount: number,
  eligibleCount: number,
  skippedCount: number,
): string {
  const lines: string[] = [];
  lines.push(
    `prx beads sync-all (mode=${result.mode}, ${candidateCount} candidates, ${eligibleCount} eligible, ${skippedCount} skipped)`,
  );
  if (result.perRepo.length === 0) {
    lines.push("  (no eligible repos)");
    lines.push(`exit ${result.exitCode}`);
    return lines.join("\n");
  }
  lines.push("");

  const slugWidth = Math.max(10, ...result.perRepo.map((r) => r.slug.length));
  const ownerWidth = Math.max(
    10,
    ...result.perRepo.map((r) => (r.nameWithOwner ?? "(no remote)").length),
  );
  const statusWidth = 9; // "skipped" / "success" / "no-op" / "conflict" / "failed"
  for (const row of result.perRepo) {
    const slug = row.slug.padEnd(slugWidth, " ");
    const owner = (row.nameWithOwner ?? "(no remote)").padEnd(ownerWidth, " ");
    const status = row.status.padEnd(statusWidth, " ");
    let detail: string;
    if (row.status === "skipped") {
      detail = row.skipReason ?? "skipped";
    } else if (row.status === "failed") {
      detail = (row.error ?? "failed").split(/\r?\n/, 1)[0] ?? "failed";
    } else if (row.status === "conflict") {
      detail = row.hint?.split(/\r?\n/, 1)[0] ?? "schema conflict";
    } else if (row.steps && row.steps.length > 0) {
      const stepNames = row.steps
        .filter((s) => s.step !== "resolve-schema")
        .map((s) => s.step)
        .join("→");
      const count = row.steps.length;
      detail = `${stepNames} (${count} step${count === 1 ? "" : "s"})`;
    } else {
      detail = row.status;
    }
    lines.push(`  ${slug} ${owner} ${status} ${detail}`);
  }
  lines.push("");

  const succeeded = result.perRepo.filter(
    (r) => r.status === "success" || r.status === "no-op",
  ).length;
  const failed = result.perRepo.filter((r) => r.status === "failed").length;
  const conflicts = result.perRepo.filter((r) => r.status === "conflict").length;
  lines.push(
    `${succeeded} succeeded, ${conflicts} conflict, ${failed} failed. exit ${result.exitCode}`,
  );
  return lines.join("\n");
}

export async function runDoltReconcileAcrossRepos(
  opts: RunDoltReconcileAcrossReposOptions,
  output: Output,
  deps: RunDoltReconcileAcrossReposDeps = {},
): Promise<{ exitCode: number; result: DoltReconcileAcrossReposResult }> {
  const now = deps.now ?? (() => new Date());
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const classifyBeadsState = deps.classifyBeadsState ?? defaultClassifyBeadsState;
  const loadCandidates =
    deps.loadCandidates ??
    ((c: string) => defaultLoadCandidates(c, classifyBeadsState, deps.runner));
  const runPerRepo = deps.runDoltReconcile ?? runDoltReconcileWithResult;
  const appendAuditRow = deps.appendAuditRow ?? defaultAppendAuditRow;
  const getAuditRuntimeContext = deps.getAuditRuntimeContext ?? defaultGetAuditRuntimeContext;
  const auditActor = getAuditRuntimeContext().actor;

  const candidates = opts.candidates ?? loadCandidates(cwd);
  if (candidates === null) {
    output.error(
      "beads sync-all: no repo inventory index — run `prx repo add` first to register a bare repo",
    );
    const empty: DoltReconcileAcrossReposResult = {
      perRepo: [],
      exitCode: 1,
      tickStartedAt: now().toISOString(),
      mode: opts.mode,
    };
    return { exitCode: 1, result: empty };
  }

  const tickStartedAt = now().toISOString();
  const eligibleCount = candidates.filter((c) => c.kind === "eligible").length;
  const skippedCount = candidates.length - eligibleCount;

  try {
    appendAuditRow({
      ts: tickStartedAt,
      kind: "catalog-event" as const,
      event: "DOLT_SYNC_ALL_STARTED",
      actor: auditActor,
      details: {
        mode: opts.mode,
        dryRun: opts.dryRun,
        candidateCount: candidates.length,
        eligibleCount,
        skippedCount,
      },
    });
  } catch {
    // sink-side errors are intentionally swallowed (mirrors run-cross-repo)
  }

  const perRepo: DoltReconcileRepoResult[] = [];

  for (const candidate of candidates) {
    if (candidate.kind === "skipped") {
      const row: DoltReconcileRepoResult = {
        slug: candidate.slug,
        nameWithOwner: candidate.nameWithOwner,
        status: "skipped",
        skipReason: candidate.reason,
        mode: opts.mode,
      };
      perRepo.push(doltReconcileRepoResultSchema.parse(row));
      try {
        appendAuditRow({
          ts: now().toISOString(),
          kind: "catalog-event" as const,
          event: "DOLT_SYNC_REPO_SKIPPED",
          actor: auditActor,
          ...(candidate.nameWithOwner ? { repo: candidate.nameWithOwner } : {}),
          details: { slug: candidate.slug, reason: candidate.reason, mode: opts.mode },
        });
      } catch {
        /* swallow */
      }
      continue;
    }

    const repo = candidate.repo;
    try {
      appendAuditRow({
        ts: now().toISOString(),
        kind: "catalog-event" as const,
        event: "DOLT_SYNC_REPO_STARTED",
        actor: auditActor,
        ...(repo.nameWithOwner ? { repo: repo.nameWithOwner } : {}),
        details: { slug: repo.slug, mode: opts.mode, dryRun: opts.dryRun },
      });
    } catch {
      /* swallow */
    }

    // Per-repo isolation (I-DR-SA2): capture the primitive's plain-text
    // ladder into a buffer so a failed run does not interleave with the
    // aggregate table; the failure is surfaced in the per-repo row.
    const captured: string[] = [];
    const repoOutput: Output = {
      log: (line) => captured.push(line),
      error: (line) => captured.push(line),
    };

    let reconcileResult: DoltReconcileResult;
    try {
      const ret = await Promise.resolve(
        runPerRepo(
          {
            repoPath: repo.barePath,
            dryRun: opts.dryRun,
            format: opts.format,
            ...(opts.resolve ? { resolve: opts.resolve } : {}),
            mode: opts.mode,
          },
          repoOutput,
        ),
      );
      reconcileResult = ret.result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const row: DoltReconcileRepoResult = {
        slug: repo.slug,
        nameWithOwner: repo.nameWithOwner,
        status: "failed",
        mode: opts.mode,
        error: message,
      };
      perRepo.push(doltReconcileRepoResultSchema.parse(row));
      try {
        appendAuditRow({
          ts: now().toISOString(),
          kind: "catalog-event" as const,
          event: "DOLT_SYNC_REPO_FAILED",
          actor: auditActor,
          ...(repo.nameWithOwner ? { repo: repo.nameWithOwner } : {}),
          details: { slug: repo.slug, mode: opts.mode, error: message },
        });
      } catch {
        /* swallow */
      }
      output.error(`beads sync-all (${repo.slug}): ${message}`);
      continue;
    }

    const classified = classifyReconcile(reconcileResult);
    const row: DoltReconcileRepoResult = {
      slug: repo.slug,
      nameWithOwner: repo.nameWithOwner,
      status: classified.status,
      mode: opts.mode,
      steps: reconcileResult.steps.map(mapStep),
      ...(classified.hint ? { hint: classified.hint } : {}),
      ...(classified.error ? { error: classified.error } : {}),
    };
    perRepo.push(doltReconcileRepoResultSchema.parse(row));

    try {
      const event =
        classified.status === "failed" || classified.status === "conflict"
          ? "DOLT_SYNC_REPO_FAILED"
          : "DOLT_SYNC_REPO_RECONCILED";
      appendAuditRow({
        ts: now().toISOString(),
        kind: "catalog-event" as const,
        event,
        actor: auditActor,
        ...(repo.nameWithOwner ? { repo: repo.nameWithOwner } : {}),
        details: {
          slug: repo.slug,
          mode: opts.mode,
          status: classified.status,
          state: reconcileResult.state,
          steps: reconcileResult.steps.length,
        },
      });
    } catch {
      /* swallow */
    }
  }

  const failedCount = perRepo.filter(
    (r) => r.status === "failed" || r.status === "conflict",
  ).length;
  const exitCode = failedCount > 0 ? 1 : 0;

  const aggregate: DoltReconcileAcrossReposResult = doltReconcileAcrossReposResultSchema.parse({
    perRepo,
    exitCode,
    tickStartedAt,
    mode: opts.mode,
  });

  try {
    appendAuditRow({
      ts: now().toISOString(),
      kind: "catalog-event" as const,
      event: "DOLT_SYNC_ALL_COMPLETED",
      actor: auditActor,
      details: {
        mode: opts.mode,
        dryRun: opts.dryRun,
        exitCode,
        perRepoCount: perRepo.length,
        eligibleCount,
        skippedCount,
        failedCount,
      },
    });
  } catch {
    /* swallow */
  }

  if (opts.format === "json") {
    output.log(JSON.stringify(aggregate, null, 2));
  } else {
    output.log(renderTable(aggregate, candidates.length, eligibleCount, skippedCount));
  }

  return { exitCode, result: aggregate };
}
