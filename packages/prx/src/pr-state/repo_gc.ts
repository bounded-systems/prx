// GH-1700 / GH-1012 — `prx repo gc [<slug>]`: repo-inventory orphan sweep.
//
// This verb originally swept embedded-dolt migration orphans left behind by the
// bd store (`embeddeddolt/<db>/` under a mainx workspace). The bd store has been
// retired (GH-1012): there is no dolt bd-store, no shared-server, and no
// per-workspace bd metadata to classify anymore. The store-specific
// classification / metadata / server-reachability probes are gone, so the sweep
// finds nothing and reports every scanned repo as `nothing-to-clean`.
//
// The report/entry shapes and the driver-facing action vocabulary
// (`swept` / `would-sweep` / `refused` / `nothing-to-clean`) are preserved so
// the machine-gc `repo` driver and audit schema keep compiling; the sweep just
// never produces a reclaimable orphan now.
//
// Pure handler with DI seams (inventory loader, audit appender, clock).
// `cli.ts` wires the defaults.

import { homeDir } from "@bounded-systems/host";

import { appendAuditRow as defaultAppendAuditRow } from "../audit/sink.ts";
import { getAuditRuntimeContext as defaultGetAuditRuntimeContext } from "@bounded-systems/audit-context";
import {
  canonicalMainxPathFromParsed,
  loadRepoInventoryIndex as defaultLoadRepoInventoryIndex,
  parseRepoUrl,
  type LocalRepo,
  type RepoInventoryConfig,
  type RepoRunner,
} from "./repos.ts";

// ── options + deps ─────────────────────────────────────────────────────────

export type RunRepoGcOptions = {
  /** Resolved by the executor via `loadRepoInventoryConfig(cwd)`. */
  config: RepoInventoryConfig;
  /** wt root used to derive the mainx workspace path. */
  wtRoot: string;
  /** When set, narrow to one slug (matched against `repo.name`). */
  slug?: string | undefined;
  /** Retained for CLI/driver compat; the sweep is now always a no-op. */
  apply: boolean;
  /** Retained for CLI/driver compat; unused now that nothing is swept. */
  yes: boolean;
};

export type RunRepoGcDeps = {
  runner?: RepoRunner;
  loadRepoInventoryIndex?: typeof defaultLoadRepoInventoryIndex;
  appendAuditRow?: typeof defaultAppendAuditRow;
  getAuditRuntimeContext?: typeof defaultGetAuditRuntimeContext;
  homeDir?: string;
  now?: () => Date;
};

// ── report shape ───────────────────────────────────────────────────────────

export type RepoGcAction = "swept" | "would-sweep" | "refused" | "nothing-to-clean";

export type RepoGcRefusalReason = "not-migrated" | "server-unreachable" | "db-empty";

export type RepoGcEntry = {
  slug: string;
  commonDir: string;
  workspacePath: string;
  classification: string;
  orphanPath: string | null;
  orphanBytes: number | null;
  action: RepoGcAction;
  refusalReason?: RepoGcRefusalReason;
};

export type RepoGcReport = {
  apply: boolean;
  scanned: number;
  orphansFound: number;
  swept: number;
  refused: number;
  cleanedBytes: number;
  durationMs: number;
  entries: RepoGcEntry[];
};

// ── error class ────────────────────────────────────────────────────────────

export class RepoGcError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RepoGcError";
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function resolveWorkspacePath(repo: LocalRepo, wtRoot: string): string | null {
  // The mainx worktree path, mirroring `repo_backfill.ts`'s derivation.
  const url = repo.primaryRemote?.url;
  if (!url) return null;
  const parsed = parseRepoUrl(url);
  if (!parsed) return null;
  return canonicalMainxPathFromParsed(wtRoot, parsed);
}

// ── handler ────────────────────────────────────────────────────────────────

export function runRepoGc(opts: RunRepoGcOptions, deps: RunRepoGcDeps = {}): RepoGcReport {
  const loadIndex = deps.loadRepoInventoryIndex ?? defaultLoadRepoInventoryIndex;
  const appendAuditRow = deps.appendAuditRow ?? defaultAppendAuditRow;
  const getCtx = deps.getAuditRuntimeContext ?? defaultGetAuditRuntimeContext;
  // homeDir is accepted for backwards-compat with callers/tests; unused now.
  void (deps.homeDir ?? homeDir());
  const now = deps.now ?? (() => new Date());

  if (!opts.config.indexPath) {
    throw new RepoGcError(
      "No `.prx/repos/index.json` resolved from this cwd. Run `prx repo gc` from a prx-managed checkout (or run `prx repo list` once to bootstrap the inventory).",
      "no_index_path",
    );
  }
  const inventory = loadIndex(opts.config.indexPath);
  if (!inventory) {
    throw new RepoGcError(
      `No repo inventory index at ${opts.config.indexPath}. Run \`prx repo list\` to populate it before sweeping.`,
      "index_missing",
    );
  }

  const targetRepos = opts.slug
    ? inventory.repos.filter((r) => r.name === opts.slug)
    : inventory.repos;
  if (opts.slug && targetRepos.length === 0) {
    throw new RepoGcError(
      `slug "${opts.slug}" not in repo inventory (${opts.config.indexPath}). Run \`prx repo list\` to refresh, or check the slug.`,
      "no_such_slug",
    );
  }

  const startMs = now().getTime();
  const actor = getCtx().actor;

  const report: RepoGcReport = {
    apply: opts.apply,
    scanned: 0,
    orphansFound: 0,
    swept: 0,
    refused: 0,
    cleanedBytes: 0,
    durationMs: 0,
    entries: [],
  };

  const emitEntry = (entry: RepoGcEntry): void => {
    report.entries.push(entry);
    appendAuditRow({
      ts: now().toISOString(),
      kind: "repo-gc-entry",
      slug: entry.slug,
      commonDir: entry.commonDir,
      workspacePath: entry.workspacePath,
      classification: entry.classification,
      orphanPath: entry.orphanPath,
      orphanBytes: entry.orphanBytes,
      action: entry.action,
      ...(entry.refusalReason ? { refusalReason: entry.refusalReason } : {}),
      apply: opts.apply,
      actor,
    });
  };

  for (const repo of targetRepos) {
    report.scanned += 1;

    // The bd store is retired: there is nothing left to classify or sweep, so
    // every scanned repo is an idempotent nothing-to-clean no-op.
    const workspacePath = resolveWorkspacePath(repo, opts.wtRoot) ?? "";
    emitEntry({
      slug: repo.name,
      commonDir: repo.commonDir,
      workspacePath,
      classification: "none",
      orphanPath: null,
      orphanBytes: null,
      action: "nothing-to-clean",
    });
  }

  report.durationMs = Math.max(0, now().getTime() - startMs);

  appendAuditRow({
    ts: now().toISOString(),
    kind: "repo-gc-run",
    scanned: report.scanned,
    orphansFound: report.orphansFound,
    swept: report.swept,
    refused: report.refused,
    cleanedBytes: report.cleanedBytes,
    apply: opts.apply,
    durationMs: report.durationMs,
    actor,
  });

  return report;
}

// ── report formatter ───────────────────────────────────────────────────────

export function formatRepoGcReport(report: RepoGcReport, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }

  const dryTag = report.apply ? "" : " (dry-run)";
  const lines: string[] = [`repo gc${dryTag}`, "================"];

  if (report.entries.length === 0) {
    lines.push("(empty inventory)");
  }

  for (const entry of report.entries) {
    const slugCol = entry.slug.padEnd(28);
    const sizeTag =
      entry.orphanBytes !== null ? `${(entry.orphanBytes / 1024 / 1024).toFixed(1)}MB` : "?MB";
    if (entry.action === "swept") {
      lines.push(`- ${slugCol} swept ${entry.orphanPath ?? ""}  [${sizeTag}]`);
    } else if (entry.action === "would-sweep") {
      lines.push(`~ ${slugCol} would-sweep ${entry.orphanPath ?? ""}  [${sizeTag}]`);
    } else if (entry.action === "refused") {
      lines.push(
        `! ${slugCol} refused (${entry.refusalReason ?? "unknown"}) ${entry.orphanPath ?? ""}`,
      );
    } else {
      lines.push(`= ${slugCol} nothing-to-clean`);
    }
  }

  lines.push("");
  lines.push(
    `scanned=${report.scanned} orphansFound=${report.orphansFound} ` +
      `swept=${report.swept} refused=${report.refused} ` +
      `cleanedBytes=${report.cleanedBytes}${dryTag}`,
  );
  return lines.join("\n");
}
