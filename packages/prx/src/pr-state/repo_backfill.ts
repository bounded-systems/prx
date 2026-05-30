// GH-1722 — `prx repo backfill`: populate `bd_workspace_prefix` on stale
// inventory entries that predate GH-1680's `.beads/` hydration in `prx repo
// add`. Aggressive bootstrap so the GH-1662 cross-repo daemon (`prx beads
// sync --all-repos`) actually iterates: every eligible entry lands a valid
// prefix — either from `bd config get database.workspace_prefix` (when the
// mainx has a hydrated `.beads/`) or from a kebab fallback derived from
// `repo.name`. Operators recover the bd-missing subset via `prx repo refresh
// <slug>` (forward-ref GH-1681); the report names that command in-band.
//
// Pure handler with DI seams (runner, hydrate fn, materialize fn, fs probes,
// audit appender, clock). The `cli.ts` executor wires the defaults.

import { existsSync as defaultExistsSync } from "node:fs";

import {
  appendAuditRow as defaultAppendAuditRow,
} from "../audit/sink.ts";
import { getAuditRuntimeContext as defaultGetAuditRuntimeContext } from "@bounded-systems/audit-context";
import {
  buildDoltRemoteUrl,
  parseGitOrigin,
} from "../beads/hydrate.ts";
import {
  hydrateAfterMaterialize as defaultHydrateAfterMaterialize,
} from "../beads/repo_hydrate.ts";
import {
  canonicalMainxPathFromParsed,
  defaultRepoRunner,
  loadRepoInventoryIndex as defaultLoadRepoInventoryIndex,
  materializeMainxIfMissing as defaultMaterializeMainxIfMissing,
  parseRepoUrl,
  readBdWorkspacePrefix as defaultReadBdWorkspacePrefix,
  RepoAddError,
  resolveDefaultBranch as defaultResolveDefaultBranch,
  verifyDefaultBranchRef as defaultVerifyDefaultBranchRef,
  WORKSPACE_PREFIX_PATTERN,
  writeRepoInventoryIndex as defaultWriteRepoInventoryIndex,
  type LocalRepo,
  type RepoInventory,
  type RepoInventoryConfig,
  type RepoRunner,
} from "./repos.ts";

// ── options + deps ─────────────────────────────────────────────────────────

export type RunRepoBackfillOptions = {
  /** Resolved by the executor via `loadRepoInventoryConfig(cwd)`. */
  config: RepoInventoryConfig;
  /** wt root used to derive the mainx path for materialization. */
  wtRoot: string;
  dryRun: boolean;
  /** BEADS_DOLTHUB_OWNER override for the report's dolt-remote URL. */
  dolthubOwner: string | null;
};

export type RunRepoBackfillDeps = {
  runner?: RepoRunner;
  loadRepoInventoryIndex?: typeof defaultLoadRepoInventoryIndex;
  writeRepoInventoryIndex?: typeof defaultWriteRepoInventoryIndex;
  materializeMainxIfMissing?: typeof defaultMaterializeMainxIfMissing;
  hydrateAfterMaterialize?: typeof defaultHydrateAfterMaterialize;
  readBdWorkspacePrefix?: typeof defaultReadBdWorkspacePrefix;
  resolveDefaultBranch?: typeof defaultResolveDefaultBranch;
  verifyDefaultBranchRef?: typeof defaultVerifyDefaultBranchRef;
  existsSync?: typeof defaultExistsSync;
  appendAuditRow?: typeof defaultAppendAuditRow;
  getAuditRuntimeContext?: typeof defaultGetAuditRuntimeContext;
  now?: () => Date;
};

// ── report shape ───────────────────────────────────────────────────────────

export type RepoBackfillEntryAction = "set" | "skipped" | "failed";
export type RepoBackfillSource = "bd-config" | "name-derived" | "preexisting";

export type RepoBackfillEntry = {
  slug: string;
  commonDir: string;
  action: RepoBackfillEntryAction;
  source?: RepoBackfillSource | undefined;
  bdWorkspacePrefix?: string | undefined;
  reason?: string | undefined;
  /**
   * GH-1736: raw stderr / unprojected message preserved alongside a normalized
   * `reason` code. Lives on the in-memory entry and is rendered in the
   * plain-text report, but is intentionally excluded from `repo-backfill-entry`
   * audit rows so the audit `reason` field stays a stable, greppable code set.
   */
  detail?: string | undefined;
  materializedMainx: boolean;
  hydrated: boolean;
  doltRemote: string | null;
};

export type RepoBackfillReport = {
  dryRun: boolean;
  scanned: number;
  populated: number;
  alreadySet: number;
  skipped: number;
  failed: number;
  bdMissing: number;
  durationMs: number;
  entries: RepoBackfillEntry[];
};

// ── error class ────────────────────────────────────────────────────────────

export class RepoBackfillError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "RepoBackfillError";
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Conservative kebab projection for the name-fallback. Underscores become
 * dashes, any other non-`[a-z0-9-]` character becomes a dash, and runs are
 * collapsed + edge-trimmed so the result conforms to
 * {@link WORKSPACE_PREFIX_PATTERN}. The handler validates the output before
 * adopting it — names that produce an empty / non-`[a-z]`-prefixed string
 * land in the `failed` bucket so the operator can supply an override in a
 * follow-up.
 */
export function kebabPrefixFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function isFileOnlyRemote(repo: LocalRepo): boolean {
  const url = repo.primaryRemote?.url ?? "";
  if (!url.startsWith("file://")) return false;
  return !repo.primaryRemote?.githubRepo;
}

function deriveDoltRemote(repo: LocalRepo, dolthubOwner: string | null): string | null {
  const url = repo.primaryRemote?.url;
  if (!url) return null;
  const components = parseGitOrigin(url);
  if (!components) return null;
  return buildDoltRemoteUrl(components, dolthubOwner);
}

// ── handler ────────────────────────────────────────────────────────────────

export function runRepoBackfill(
  opts: RunRepoBackfillOptions,
  deps: RunRepoBackfillDeps = {},
): RepoBackfillReport {
  const runner = deps.runner ?? defaultRepoRunner;
  const loadIndex = deps.loadRepoInventoryIndex ?? defaultLoadRepoInventoryIndex;
  const writeIndex = deps.writeRepoInventoryIndex ?? defaultWriteRepoInventoryIndex;
  const materialize = deps.materializeMainxIfMissing ?? defaultMaterializeMainxIfMissing;
  const hydrate = deps.hydrateAfterMaterialize ?? defaultHydrateAfterMaterialize;
  const readPrefix = deps.readBdWorkspacePrefix ?? defaultReadBdWorkspacePrefix;
  const resolveDefaultBranch = deps.resolveDefaultBranch ?? defaultResolveDefaultBranch;
  const verifyDefaultBranchRef = deps.verifyDefaultBranchRef ?? defaultVerifyDefaultBranchRef;
  const exists = deps.existsSync ?? defaultExistsSync;
  const appendAuditRow = deps.appendAuditRow ?? defaultAppendAuditRow;
  const getCtx = deps.getAuditRuntimeContext ?? defaultGetAuditRuntimeContext;
  const now = deps.now ?? (() => new Date());

  if (!opts.config.indexPath) {
    throw new RepoBackfillError(
      "No `.prx/repos/index.json` resolved from this cwd. Run `prx repo backfill` from a prx-managed checkout (or run `prx repo list` once to bootstrap the inventory).",
      "no_index_path",
    );
  }
  const inventory = loadIndex(opts.config.indexPath);
  if (!inventory) {
    throw new RepoBackfillError(
      `No repo inventory index at ${opts.config.indexPath}. Run \`prx repo list\` to populate it before backfilling.`,
      "index_missing",
    );
  }

  const startMs = now().getTime();
  const actor = getCtx().actor;

  const prefixesInUse = new Set<string>();
  for (const repo of inventory.repos) {
    if (repo.bd_workspace_prefix) {
      prefixesInUse.add(repo.bd_workspace_prefix);
    }
  }

  const report: RepoBackfillReport = {
    dryRun: opts.dryRun,
    scanned: 0,
    populated: 0,
    alreadySet: 0,
    skipped: 0,
    failed: 0,
    bdMissing: 0,
    durationMs: 0,
    entries: [],
  };

  let mutated = false;

  for (let i = 0; i < inventory.repos.length; i += 1) {
    const repo = inventory.repos[i]!;
    report.scanned += 1;
    const doltRemote = deriveDoltRemote(repo, opts.dolthubOwner);

    const emitEntry = (entry: RepoBackfillEntry): void => {
      report.entries.push(entry);
      appendAuditRow({
        ts: now().toISOString(),
        kind: "repo-backfill-entry",
        slug: entry.slug,
        commonDir: entry.commonDir,
        ...(entry.bdWorkspacePrefix ? { bdWorkspacePrefix: entry.bdWorkspacePrefix } : {}),
        ...(entry.source ? { source: entry.source } : {}),
        action: entry.action,
        ...(entry.reason ? { reason: entry.reason } : {}),
        materializedMainx: entry.materializedMainx,
        hydrated: entry.hydrated,
        ...(entry.doltRemote ? { doltRemote: entry.doltRemote } : {}),
        dryRun: opts.dryRun,
        actor,
      });
    };

    if (repo.bd_workspace_prefix && repo.bd_workspace_prefix.length > 0) {
      report.alreadySet += 1;
      emitEntry({
        slug: repo.name,
        commonDir: repo.commonDir,
        action: "skipped",
        source: "preexisting",
        bdWorkspacePrefix: repo.bd_workspace_prefix,
        materializedMainx: false,
        hydrated: false,
        doltRemote,
      });
      continue;
    }

    if (repo.kind !== "bare") {
      report.skipped += 1;
      emitEntry({
        slug: repo.name,
        commonDir: repo.commonDir,
        action: "skipped",
        reason: "non_bare_kind",
        materializedMainx: false,
        hydrated: false,
        doltRemote,
      });
      continue;
    }

    if (!exists(repo.commonDir)) {
      report.skipped += 1;
      emitEntry({
        slug: repo.name,
        commonDir: repo.commonDir,
        action: "skipped",
        reason: "commondir_missing",
        materializedMainx: false,
        hydrated: false,
        doltRemote,
      });
      continue;
    }

    if (isFileOnlyRemote(repo)) {
      report.skipped += 1;
      emitEntry({
        slug: repo.name,
        commonDir: repo.commonDir,
        action: "skipped",
        reason: "local_only_repo",
        materializedMainx: false,
        hydrated: false,
        doltRemote,
      });
      continue;
    }

    const parsed = repo.primaryRemote?.url ? parseRepoUrl(repo.primaryRemote.url) : null;
    if (!parsed) {
      report.skipped += 1;
      emitEntry({
        slug: repo.name,
        commonDir: repo.commonDir,
        action: "skipped",
        reason: "unparseable_remote",
        materializedMainx: false,
        hydrated: false,
        doltRemote,
      });
      continue;
    }

    const mainxPath = canonicalMainxPathFromParsed(opts.wtRoot, parsed);

    if (opts.dryRun) {
      // GH-1736: probe `origin/<default>` existence so dry-run forecasts the
      // same `default_branch_unresolved` failures apply would hit. Loosens
      // the prior zero-subprocess invariant to zero-mutation — these are
      // read-only `git rev-parse` calls, O(N) over surviving entries.
      try {
        const branch = resolveDefaultBranch(repo.commonDir, runner);
        verifyDefaultBranchRef(repo.commonDir, branch, runner);
      } catch (err) {
        if (err instanceof RepoAddError && err.code === "default_branch_unresolved") {
          report.failed += 1;
          emitEntry({
            slug: repo.name,
            commonDir: repo.commonDir,
            action: "failed",
            reason: err.code,
            detail: err.message,
            materializedMainx: false,
            hydrated: false,
            doltRemote,
          });
          continue;
        }
        throw err;
      }

      // Zero-subprocess invariant: we cannot probe `bd config get` without
      // materializing the mainx. Predict the name-derived prefix, validate
      // it, and stand the entry up in the report so the operator sees what
      // the apply pass will write. `bdMissing` is counted as an upper bound
      // (an apply pass may discover bd-config later for a subset).
      const predicted = kebabPrefixFromName(repo.name);
      if (!WORKSPACE_PREFIX_PATTERN.test(predicted)) {
        report.failed += 1;
        emitEntry({
          slug: repo.name,
          commonDir: repo.commonDir,
          action: "failed",
          reason: `name_unprojectable:${predicted || "<empty>"}`,
          materializedMainx: false,
          hydrated: false,
          doltRemote,
        });
        continue;
      }
      if (prefixesInUse.has(predicted)) {
        report.failed += 1;
        emitEntry({
          slug: repo.name,
          commonDir: repo.commonDir,
          action: "failed",
          reason: `prefix_collision:${predicted}`,
          materializedMainx: false,
          hydrated: false,
          doltRemote,
        });
        continue;
      }
      report.populated += 1;
      report.bdMissing += 1;
      emitEntry({
        slug: repo.name,
        commonDir: repo.commonDir,
        action: "set",
        source: "name-derived",
        bdWorkspacePrefix: predicted,
        materializedMainx: false,
        hydrated: false,
        doltRemote,
      });
      continue;
    }

    let materializedMainx = false;
    let hydrated = false;
    try {
      const result = materialize(repo.commonDir, mainxPath, runner);
      materializedMainx = result.created;

      try {
        const hydrateResult = hydrate(mainxPath);
        hydrated =
          hydrateResult.status === "hydrated" ||
          hydrateResult.status === "already-hydrated";
      } catch {
        // hydrate is best-effort; a thrown error here is surprising (the
        // wrapper is designed to capture failure on the result) but must not
        // sink the per-entry attempt — we can still try `bd config get` and
        // fall back to the name derivation either way.
        hydrated = false;
      }

      let prefix: string;
      let source: RepoBackfillSource;
      try {
        prefix = readPrefix(mainxPath, runner);
        source = "bd-config";
      } catch (err) {
        if (!(err instanceof RepoAddError)) throw err;
        prefix = kebabPrefixFromName(repo.name);
        if (!WORKSPACE_PREFIX_PATTERN.test(prefix)) {
          throw new RepoBackfillError(
            `name_unprojectable:${prefix || "<empty>"}`,
            "name_unprojectable",
          );
        }
        source = "name-derived";
        report.bdMissing += 1;
      }

      if (prefixesInUse.has(prefix)) {
        throw new RepoBackfillError(
          `prefix_collision:${prefix}`,
          "prefix_collision",
        );
      }

      inventory.repos[i] = { ...repo, bd_workspace_prefix: prefix };
      prefixesInUse.add(prefix);
      mutated = true;
      report.populated += 1;
      emitEntry({
        slug: repo.name,
        commonDir: repo.commonDir,
        action: "set",
        source,
        bdWorkspacePrefix: prefix,
        materializedMainx,
        hydrated,
        // Surface the dolt-remote URL only for name-derived populates — that
        // is the subset the operator needs to hydrate after the fact.
        doltRemote: source === "name-derived" ? doltRemote : null,
      });
    } catch (err) {
      // GH-1736: normalize `repo-backfill-entry` audit `reason` to the
      // documented code set. `RepoAddError` collapses to its bare `code` with
      // the raw stderr preserved on `detail`. `RepoBackfillError` already
      // shapes its messages as colon-suffixed codes (`name_unprojectable:…`,
      // `prefix_collision:…`) so it continues to flow through `err.message`.
      const reason =
        err instanceof RepoAddError ? err.code :
        err instanceof Error ? err.message : String(err);
      const detail = err instanceof RepoAddError ? err.message : undefined;
      report.failed += 1;
      emitEntry({
        slug: repo.name,
        commonDir: repo.commonDir,
        action: "failed",
        reason,
        detail,
        materializedMainx,
        hydrated,
        doltRemote,
      });
    }
  }

  if (mutated && !opts.dryRun) {
    writeIndex(opts.config.indexPath, inventory);
  }

  report.durationMs = Math.max(0, now().getTime() - startMs);

  appendAuditRow({
    ts: now().toISOString(),
    kind: "repo-backfill-run",
    scanned: report.scanned,
    populated: report.populated,
    alreadySet: report.alreadySet,
    skipped: report.skipped,
    failed: report.failed,
    bdMissing: report.bdMissing,
    dryRun: opts.dryRun,
    durationMs: report.durationMs,
    actor,
  });

  return report;
}

// ── report formatter ───────────────────────────────────────────────────────

export function formatRepoBackfill(
  report: RepoBackfillReport,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }

  const dryTag = report.dryRun ? " (dry-run)" : "";
  const lines: string[] = [
    `repo backfill${dryTag}`,
    "================",
  ];

  if (report.entries.length === 0) {
    lines.push("(empty inventory)");
  }

  for (const entry of report.entries) {
    const slugCol = entry.slug.padEnd(28);
    if (entry.action === "set") {
      const tag = entry.source === "bd-config" ? "bd-config" : "name-derived";
      const mainxTag = entry.materializedMainx ? "mainx-created" : "mainx-existed";
      const beadsTag = entry.hydrated ? "hydrated" : "beads-missing";
      lines.push(
        `+ ${slugCol} prefix=${entry.bdWorkspacePrefix ?? ""}  [${tag}, ${mainxTag}, ${beadsTag}]`,
      );
      if (entry.source === "name-derived") {
        lines.push(`    bootstrap: prx repo refresh ${entry.slug}  (forward-ref GH-1681)`);
        if (entry.doltRemote) {
          lines.push(`    dolt-remote: ${entry.doltRemote}`);
        }
      }
    } else if (entry.action === "skipped") {
      if (entry.source === "preexisting") {
        lines.push(
          `= ${slugCol} prefix=${entry.bdWorkspacePrefix ?? ""}  [preexisting]`,
        );
      } else {
        lines.push(`- ${slugCol} [skipped: ${entry.reason ?? "unknown"}]`);
      }
    } else {
      lines.push(`! ${slugCol} [failed: ${entry.reason ?? "unknown"}]`);
      if (entry.detail) {
        lines.push(`    detail: ${entry.detail}`);
      }
      if (entry.doltRemote) {
        lines.push(`    dolt-remote: ${entry.doltRemote}`);
      }
    }
  }

  lines.push("");
  lines.push(
    `scanned=${report.scanned} populated=${report.populated} alreadySet=${report.alreadySet} ` +
      `skipped=${report.skipped} failed=${report.failed} bdMissing=${report.bdMissing}${dryTag}`,
  );
  return lines.join("\n");
}
