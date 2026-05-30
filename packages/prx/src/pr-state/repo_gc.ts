// GH-1700 — `prx repo gc [<slug>]`: migration-orphan sweep.
//
// Closes the GH-493 loop opened by GH-1706 (`prx beads migrate`). After an
// embedded → shared-server migration, `.beads/embeddeddolt/<dbname>/` remains
// on disk in the mainx workspace; bd no longer reads from it, but bd also does
// not sweep it. This verb is the cleanup layer: dry-run by default, mutates
// only with `--apply`, and only after every GC-I1..I3 precondition holds.
//
// Scope (v1): the single path `<workspacePath>/.beads/embeddeddolt/<dbname>/`.
// Per-project (`.beads/dolt/`) sweeps, metadata-mode repair, and operator
// backups are explicitly out of scope.
//
// Pure handler with DI seams (runner, fs probes, audit appender, prompt, clock).
// `cli.ts` wires the defaults.

import {
  existsSync as defaultExistsSync,
  readdirSync as defaultReaddirSync,
  readSync as defaultReadSync,
  rmSync as defaultRmSync,
  statSync as defaultStatSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { appendAuditRow as defaultAppendAuditRow } from "../audit/sink.ts";
import { getAuditRuntimeContext as defaultGetAuditRuntimeContext } from "@bounded-systems/audit-context";
import {
  classifyBeadsWorkspace as defaultClassifyBeadsWorkspace,
  probeSharedServerHasIssues as defaultProbeSharedServerHasIssues,
  readBeadsMetadata as defaultReadBeadsMetadata,
  type BeadsWorkspaceMode,
} from "../beads/workspace_mode.ts";
import {
  canonicalMainxPathFromParsed,
  defaultRepoRunner,
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
  /** True ⇒ actually `rm -rf` the orphan; false ⇒ dry-run plan only. */
  apply: boolean;
  /** Bypass interactive confirmation when `apply: true`. */
  yes: boolean;
};

export type PromptConfirmFn = (message: string) => boolean;

export type RunRepoGcDeps = {
  runner?: RepoRunner;
  loadRepoInventoryIndex?: typeof defaultLoadRepoInventoryIndex;
  classifyBeadsWorkspace?: typeof defaultClassifyBeadsWorkspace;
  readBeadsMetadata?: typeof defaultReadBeadsMetadata;
  probeSharedServerHasIssues?: (workspacePath: string) => boolean;
  existsSync?: typeof defaultExistsSync;
  readdirSync?: typeof defaultReaddirSync;
  statSync?: typeof defaultStatSync;
  rmSync?: typeof defaultRmSync;
  promptConfirm?: PromptConfirmFn;
  appendAuditRow?: typeof defaultAppendAuditRow;
  getAuditRuntimeContext?: typeof defaultGetAuditRuntimeContext;
  homeDir?: string;
  now?: () => Date;
};

// ── report shape ───────────────────────────────────────────────────────────

export type RepoGcAction =
  | "swept"
  | "would-sweep"
  | "refused"
  | "nothing-to-clean";

export type RepoGcRefusalReason =
  | "not-migrated"
  | "server-unreachable"
  | "db-empty";

export type RepoGcEntry = {
  slug: string;
  commonDir: string;
  workspacePath: string;
  classification: BeadsWorkspaceMode["kind"];
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
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "RepoGcError";
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function isFileOnlyRemote(repo: LocalRepo): boolean {
  const url = repo.primaryRemote?.url ?? "";
  if (!url.startsWith("file://")) return false;
  return !repo.primaryRemote?.githubRepo;
}

function resolveWorkspacePath(
  repo: LocalRepo,
  wtRoot: string,
): string | null {
  // The hydrated `.beads/` lives in the materialized mainx worktree, not in
  // the bare commonDir — mirror `repo_backfill.ts`'s derivation.
  const url = repo.primaryRemote?.url;
  if (!url) return null;
  const parsed = parseRepoUrl(url);
  if (!parsed) return null;
  return canonicalMainxPathFromParsed(wtRoot, parsed);
}

function dirSizeBytes(
  path: string,
  readdir: typeof defaultReaddirSync,
  stat: typeof defaultStatSync,
): number {
  let total = 0;
  let queue: string[] = [path];
  while (queue.length > 0) {
    const next = queue.pop()!;
    let entries: string[];
    try {
      entries = readdir(next);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(next, entry);
      try {
        const st = stat(full);
        if (st.isDirectory()) {
          queue.push(full);
        } else {
          total += st.size;
        }
      } catch {
        // skip unreadable entries — size is best-effort
      }
    }
  }
  return total;
}

// ── handler ────────────────────────────────────────────────────────────────

export function runRepoGc(
  opts: RunRepoGcOptions,
  deps: RunRepoGcDeps = {},
): RepoGcReport {
  const runner = deps.runner ?? defaultRepoRunner;
  const loadIndex = deps.loadRepoInventoryIndex ?? defaultLoadRepoInventoryIndex;
  const classify = deps.classifyBeadsWorkspace ?? defaultClassifyBeadsWorkspace;
  const readMetadata = deps.readBeadsMetadata ?? defaultReadBeadsMetadata;
  const probeIssues =
    deps.probeSharedServerHasIssues ??
    ((workspacePath: string) => defaultProbeSharedServerHasIssues(workspacePath));
  const exists = deps.existsSync ?? defaultExistsSync;
  const readdir = deps.readdirSync ?? defaultReaddirSync;
  const stat = deps.statSync ?? defaultStatSync;
  const rm = deps.rmSync ?? defaultRmSync;
  const promptConfirm = deps.promptConfirm ?? defaultPromptConfirm;
  const appendAuditRow = deps.appendAuditRow ?? defaultAppendAuditRow;
  const getCtx = deps.getAuditRuntimeContext ?? defaultGetAuditRuntimeContext;
  const home = deps.homeDir ?? homedir();
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

    const workspacePath = resolveWorkspacePath(repo, opts.wtRoot);
    if (!workspacePath || isFileOnlyRemote(repo)) {
      emitEntry({
        slug: repo.name,
        commonDir: repo.commonDir,
        workspacePath: workspacePath ?? "",
        classification: "none",
        orphanPath: null,
        orphanBytes: null,
        action: "nothing-to-clean",
      });
      continue;
    }

    // GC-I1: only sweep when shared-server classification is present. Run the
    // disk-shape classifier first so the entry's `classification` field is
    // honest about the workspace shape we observed.
    const mode = classify(workspacePath, { homeDir: home });

    // GC-I5: nothing on disk → idempotent no-op.
    const metadata = readMetadata(join(workspacePath, ".beads"));
    const dbName = metadata.dolt_database;
    const orphanPath = dbName
      ? join(workspacePath, ".beads", "embeddeddolt", dbName)
      : null;
    const hasOrphan = orphanPath !== null && exists(orphanPath);

    if (!hasOrphan) {
      emitEntry({
        slug: repo.name,
        commonDir: repo.commonDir,
        workspacePath,
        classification: mode.kind,
        orphanPath: null,
        orphanBytes: null,
        action: "nothing-to-clean",
      });
      continue;
    }

    report.orphansFound += 1;

    if (mode.kind !== "shared_server") {
      report.refused += 1;
      emitEntry({
        slug: repo.name,
        commonDir: repo.commonDir,
        workspacePath,
        classification: mode.kind,
        orphanPath,
        orphanBytes: null,
        action: "refused",
        refusalReason: "not-migrated",
      });
      continue;
    }

    // GC-I3a: shared-server dolt root must exist.
    const sharedDir = join(home, ".beads", "shared-server", "dolt", dbName!);
    if (!exists(sharedDir)) {
      report.refused += 1;
      emitEntry({
        slug: repo.name,
        commonDir: repo.commonDir,
        workspacePath,
        classification: mode.kind,
        orphanPath,
        orphanBytes: null,
        action: "refused",
        refusalReason: "server-unreachable",
      });
      continue;
    }

    // GC-I3b: shared-server must report ≥1 issue (proves bd reads from the
    // server, not from the orphan).
    if (!probeIssues(workspacePath)) {
      report.refused += 1;
      emitEntry({
        slug: repo.name,
        commonDir: repo.commonDir,
        workspacePath,
        classification: mode.kind,
        orphanPath,
        orphanBytes: null,
        action: "refused",
        refusalReason: "db-empty",
      });
      continue;
    }

    const orphanBytes = dirSizeBytes(orphanPath!, readdir, stat);

    if (!opts.apply) {
      emitEntry({
        slug: repo.name,
        commonDir: repo.commonDir,
        workspacePath,
        classification: mode.kind,
        orphanPath,
        orphanBytes,
        action: "would-sweep",
      });
      continue;
    }

    // GC-I4: interactive confirmation gates `--apply` unless `--yes`.
    if (!opts.yes) {
      const sizeMb = (orphanBytes / 1024 / 1024).toFixed(1);
      const ok = promptConfirm(
        `repo gc: remove ${orphanPath} (~${sizeMb} MB)? [y/N] `,
      );
      if (!ok) {
        emitEntry({
          slug: repo.name,
          commonDir: repo.commonDir,
          workspacePath,
          classification: mode.kind,
          orphanPath,
          orphanBytes,
          action: "would-sweep",
        });
        continue;
      }
    }

    rm(orphanPath!, { recursive: true, force: true });
    report.swept += 1;
    report.cleanedBytes += orphanBytes;
    emitEntry({
      slug: repo.name,
      commonDir: repo.commonDir,
      workspacePath,
      classification: mode.kind,
      orphanPath,
      orphanBytes,
      action: "swept",
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

function defaultPromptConfirm(message: string): boolean {
  // Synchronous tty prompt. Tests inject a stub via `deps.promptConfirm`.
  process.stdout.write(message);
  const buf = Buffer.alloc(64);
  let read = 0;
  try {
    read = defaultReadSync(0, buf, 0, buf.length, null);
  } catch {
    return false;
  }
  const answer = buf.subarray(0, read).toString("utf8").trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

// ── report formatter ───────────────────────────────────────────────────────

export function formatRepoGcReport(
  report: RepoGcReport,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }

  const dryTag = report.apply ? "" : " (dry-run)";
  const lines: string[] = [
    `repo gc${dryTag}`,
    "================",
  ];

  if (report.entries.length === 0) {
    lines.push("(empty inventory)");
  }

  for (const entry of report.entries) {
    const slugCol = entry.slug.padEnd(28);
    const sizeTag =
      entry.orphanBytes !== null
        ? `${(entry.orphanBytes / 1024 / 1024).toFixed(1)}MB`
        : "?MB";
    if (entry.action === "swept") {
      lines.push(`- ${slugCol} swept ${entry.orphanPath ?? ""}  [${sizeTag}]`);
    } else if (entry.action === "would-sweep") {
      lines.push(
        `~ ${slugCol} would-sweep ${entry.orphanPath ?? ""}  [${sizeTag}]`,
      );
    } else if (entry.action === "refused") {
      lines.push(
        `! ${slugCol} refused (${entry.refusalReason ?? "unknown"}) ${entry.orphanPath ?? ""}`,
      );
      if (entry.refusalReason === "not-migrated") {
        lines.push(
          `    hint: run \`prx beads migrate ${entry.slug}\` first (GH-1706)`,
        );
      } else if (entry.refusalReason === "server-unreachable") {
        lines.push(
          `    hint: shared-server dolt root missing — investigate \`~/.beads/shared-server/dolt/\``,
        );
      } else if (entry.refusalReason === "db-empty") {
        lines.push(
          `    hint: shared-server returned no issues — refusing to sweep until reachable + populated`,
        );
      }
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
