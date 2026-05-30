// GH-1662 — cross-repo `prx beads sync --all-repos` orchestrator.
//
// Walks `.prx/repos/index.json` and runs the GH-1537 single-repo
// `runBeadsSync()` once per indexed bare repo, sharing the GitHub-API budget
// across all repos (the rate-limit counter is global; per-repo budget pools
// would race the same counter). When the budget drains mid-walk the cursor
// at `$XDG_STATE_HOME/prx/sync/cross-repo-cursor.json` pins the repo to
// resume at; on full drain the cursor is cleared so the next tick starts
// at the top.
//
// Workflow-model alignment (ADR §10 / `prx actors --scope workflow`):
//   - Actor: `domain_sync` (existing). Three new emits added (GH-1662):
//     DOMAIN_SYNC_REPO_STARTED, DOMAIN_SYNC_REPO_COMPLETED, DOMAIN_SYNC_REPO_SKIPPED.
//   - Materialize seam: `materializeBareRepo()` (GH-1660). Daemon path expects
//     `action: "noop"` in steady state.
//
// Invariants (informal; mirror I-DS1/I-DS2 shape):
//   - I-DS3 cursor monotonicity. Within an in-progress tick the cursor only
//     advances; on full drain the file is deleted.
//   - I-DS4 budget sharing. A single `refreshBudget()` snapshot is consulted
//     at the start of each per-repo pass; exhausting it mid-walk pins
//     `nextRepoSlug` and defers the remaining repos.
//   - I-DS5 materialize idempotency. A daemon tick over an unchanged inventory
//     with fresh-fetched bares yields N `action:"noop"` results and zero
//     `git fetch` syscalls (per `materializeBareRepo` freshness window).
//   - I-DS6 dry-run no writes (cross-repo). `--dry-run` triggers no
//     `gh issue edit`, no `bd github sync`, no `git fetch`, no cursor write.

import {
  loadRepoInventoryConfig,
  loadRepoInventoryIndex,
  listIndexedReposForReconcile,
  type IndexedRepoForReconcile,
  type RepoRunner,
} from "../pr-state/repos.ts";
import {
  materializeBareRepo as defaultMaterializeBareRepo,
  type MaterializeResult,
} from "../pr-state/materialize.ts";
import { appendAuditRow as defaultAppendAuditRow } from "../audit/sink.ts";
import { getAuditRuntimeContext as defaultGetAuditRuntimeContext } from "@bounded-systems/audit-context";
import { loadAllBeads as defaultLoadAllBeads } from "../triage/triage.ts";
import { execBd } from "@bounded-systems/bd";
import {
  runBeadsSync,
  type BeadsSyncResult,
  type RunBeadsSyncDeps,
  type RunBeadsSyncOptions,
} from "./run.ts";
import {
  clearCrossRepoCursor as defaultClearCrossRepoCursor,
  readCrossRepoCursor as defaultReadCrossRepoCursor,
  writeCrossRepoCursor as defaultWriteCrossRepoCursor,
  type CrossRepoCursor,
} from "./cross-repo-cursor.ts";

export type RunBeadsSyncAcrossReposOptions = Omit<RunBeadsSyncOptions, "repo"> & {
  /** When true, skip the cursor and walk index from the top. Default false. */
  ignoreCursor?: boolean;
};

export type CrossRepoResult = {
  exitCode: number;
  /** One `BeadsSyncResult` per repo touched this tick (in walk order). */
  perRepo: BeadsSyncResult[];
  /** True iff any per-repo pass paused (entry-gate or mid-pair budget cutoff). */
  budgetPaused: boolean;
  /** True iff every indexed repo was visited this tick (cursor cleared). */
  drained: boolean;
  /** Final on-disk cursor state (`null` when drained). */
  cursorAfter: CrossRepoCursor | null;
  /** Indexed-repo entries this tick attempted (in walk order). */
  reposAttempted: IndexedRepoForReconcile[];
  /** Repos skipped because `materializeBareRepo` threw. */
  reposSkipped: { slug: string; error: string }[];
};

export type RunBeadsSyncAcrossReposDeps = {
  /** Override the discovered cwd (used to resolve the inventory). */
  cwd?: () => string;
  /** Inventory loader seam — tests inject the index directly. */
  loadInventory?: (cwd: string) => IndexedRepoForReconcile[] | null;
  /** Materialize seam — tests stub action arms / failures. */
  materializeBareRepo?: typeof defaultMaterializeBareRepo;
  /** Cursor I/O seams. */
  readCursor?: typeof defaultReadCrossRepoCursor;
  writeCursor?: typeof defaultWriteCrossRepoCursor;
  clearCursor?: typeof defaultClearCrossRepoCursor;
  /** Per-repo `runBeadsSync` invocation seam. */
  runBeadsSync?: typeof runBeadsSync;
  /** Per-repo deps factory; the orchestrator binds `loadAllBeads` to the bare path. */
  perRepoDeps?: (repo: IndexedRepoForReconcile) => RunBeadsSyncDeps;
  /** Audit sink + runtime-context seams (mirror `RunBeadsSyncDeps`). */
  appendAuditRow?: typeof defaultAppendAuditRow;
  getAuditRuntimeContext?: typeof defaultGetAuditRuntimeContext;
  /** Clock seam (tickStartedAt + audit row ts). */
  now?: () => Date;
  /** Repo-runner seam (for inventory-config probing). */
  runner?: RepoRunner;
};

function defaultLoadInventory(cwd: string, runner?: RepoRunner): IndexedRepoForReconcile[] | null {
  const config = loadRepoInventoryConfig(cwd, runner);
  if (!config.indexPath) return null;
  const inventory = loadRepoInventoryIndex(config.indexPath);
  if (!inventory) return null;
  return listIndexedReposForReconcile(inventory);
}

function defaultPerRepoDeps(repo: IndexedRepoForReconcile): RunBeadsSyncDeps {
  return {
    cwd: () => repo.barePath,
    // GH-1662: bind `loadAllBeads` to the per-repo bare path so each
    // reconcile pass reads the right `bd` workspace.
    loadAllBeads: (exec = execBd, warn = () => {}) =>
      defaultLoadAllBeads(exec, warn, repo.barePath),
  };
}

export async function runBeadsSyncAcrossRepos(
  opts: RunBeadsSyncAcrossReposOptions,
  output: { log: (line: string) => void; error: (line: string) => void },
  deps: RunBeadsSyncAcrossReposDeps = {},
): Promise<CrossRepoResult> {
  const now = deps.now ?? (() => new Date());
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const runner = deps.runner;
  const loadInventory = deps.loadInventory ?? ((c: string) => defaultLoadInventory(c, runner));
  const materialize = deps.materializeBareRepo ?? defaultMaterializeBareRepo;
  const readCursor = deps.readCursor ?? defaultReadCrossRepoCursor;
  const writeCursor = deps.writeCursor ?? defaultWriteCrossRepoCursor;
  const clearCursor = deps.clearCursor ?? defaultClearCrossRepoCursor;
  const runPerRepo = deps.runBeadsSync ?? runBeadsSync;
  const perRepoDeps = deps.perRepoDeps ?? defaultPerRepoDeps;
  const appendAuditRow = deps.appendAuditRow ?? defaultAppendAuditRow;
  const getAuditRuntimeContext = deps.getAuditRuntimeContext ?? defaultGetAuditRuntimeContext;
  const auditActor = getAuditRuntimeContext().actor;

  const repos = loadInventory(cwd);
  if (repos === null) {
    output.error("beads sync (--all-repos): no repo inventory index — run `prx repo add` first");
    return {
      exitCode: 1,
      perRepo: [],
      budgetPaused: false,
      drained: false,
      cursorAfter: null,
      reposAttempted: [],
      reposSkipped: [],
    };
  }
  if (repos.length === 0) {
    output.log("beads sync (--all-repos): inventory has no eligible repos (none with bd_workspace_prefix + OWNER/REPO)");
    return {
      exitCode: 0,
      perRepo: [],
      budgetPaused: false,
      drained: true,
      cursorAfter: null,
      reposAttempted: [],
      reposSkipped: [],
    };
  }

  const cursor = opts.ignoreCursor ? null : readCursor();
  const startIdx = cursor?.nextRepoSlug
    ? Math.max(0, repos.findIndex((r) => r.slug === cursor.nextRepoSlug))
    : 0;
  const tickStartedAt = cursor?.tickStartedAt ?? now().toISOString();

  const perRepo: BeadsSyncResult[] = [];
  const reposAttempted: IndexedRepoForReconcile[] = [];
  const reposSkipped: { slug: string; error: string }[] = [];

  for (let i = startIdx; i < repos.length; i++) {
    const repo = repos[i]!;
    reposAttempted.push(repo);

    // 1. Materialize the bare. Skip + continue on failure (per design choice).
    let mat: MaterializeResult;
    try {
      mat = materialize({ name: repo.slug, dryRun: opts.dryRun });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reposSkipped.push({ slug: repo.slug, error: message });
      try {
        appendAuditRow({
          ts: now().toISOString(),
          kind: "domain-sync-materialize-failed" as const,
          repo: repo.nameWithOwner,
          error: message,
          actor: auditActor,
          dryRun: opts.dryRun,
        });
      } catch {
        // sink-side errors are intentionally swallowed
      }
      output.error(`beads sync (${repo.slug}): materialize failed — ${message}`);
      continue;
    }
    void mat; // emitted via materializeBareRepo's caller-side audit; daemon path expects "noop" steady-state

    // 2. Reconcile this repo against its bare path.
    const result = await runPerRepo(
      {
        repo: repo.nameWithOwner,
        domain: opts.domain,
        dryRun: opts.dryRun,
        budget: opts.budget,
        limit: opts.limit,
        format: opts.format,
      },
      output,
      perRepoDeps(repo),
    );
    perRepo.push(result);

    // 3. Budget-pause handling. Pin the cursor at THIS repo (not i+1) so a
    //    paused mid-repo tick re-runs from the same repo next time.
    if (result.summary.budgetPaused) {
      if (!opts.dryRun) {
        writeCursor({ tickStartedAt, nextRepoSlug: repo.slug });
      }
      return {
        exitCode: 0,
        perRepo,
        budgetPaused: true,
        drained: false,
        cursorAfter: opts.dryRun ? null : { tickStartedAt, nextRepoSlug: repo.slug },
        reposAttempted,
        reposSkipped,
      };
    }
  }

  // Full drain — clear the cursor so the next tick starts at the top.
  if (!opts.dryRun) {
    clearCursor();
  }
  return {
    exitCode: 0,
    perRepo,
    budgetPaused: false,
    drained: true,
    cursorAfter: null,
    reposAttempted,
    reposSkipped,
  };
}
