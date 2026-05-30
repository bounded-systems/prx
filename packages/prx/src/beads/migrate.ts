// GH-1706 — `prx beads migrate [<slug>]`.
//
// One-call migration of a registered, embedded-mode bd workspace into
// shared-server mode. Closes the loop opened by GH-1701 (`prx repo audit`,
// which inventories Bucket B) for the GH-493 fleet rollout: the manual
// recipe (~6 hand-built steps + 4 paper cuts) is not viable to repeat 4–8
// more times across the fleet.
//
// Sister verbs handle remote wiring and orphan sweep separately —
// `prx repo add-dolthub <slug>` (GH-1703) and `prx repo gc <slug>`
// (GH-1700). This verb stops at "ready for add-dolthub" and hints the
// next step.
//
// Apply-by-default; `--dry-run` is opt-in. bd's own
// `--destroy-token=DESTROY-<prefix>` is the strong gate; doubling it on the
// prx side adds friction without safety value.
//
// `--patch-metadata` is default-on so the GH-1695 `dolt_mode` workaround
// stays in-verb until bd-upstream's metadata-persistence fix lands; the
// flag flips off so the workaround retires without code surgery.
//
// Backups land under `~/.local/state/prx/migrations/<slug>-<ISO-ts>/`
// (NOT `/tmp` — survives reboots; consistent with the audit sink under
// `~/.local/state/prx/audit/`). The backup is preserved on failure for
// manual rollback (`bd init --from-jsonl <backupDir>/issues.jsonl`).
//
// The transition shape is a Zod discriminated union so a future
// `per-project → shared-server` arm can land as v2 without reshape.

import {
  cpSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  classifyBeadsWorkspace,
  type BeadsWorkspaceMode,
} from "./workspace_mode.ts";
import {
  defaultBdMigrateRunner,
  type BdMigrateRunner,
} from "./migrate_runner.ts";
import { patchBeadsMetadataDoltMode } from "./metadata_patch.ts";
import {
  isCaptureFailure,
  type SpawnCaptureResult,
} from "@bounded-systems/proc";
import { recordEvent as defaultRecordEvent } from "../machine/record_event.ts";
import {
  loadRepoInventoryConfig,
  loadRepoInventoryIndex,
  localRepoForCwd,
  type LocalRepo,
} from "../pr-state/repos.ts";

// ---- schemas ---------------------------------------------------------------

export const migrateTransitionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("embedded-to-shared-server") }),
  // v2 hook: { kind: "per-project-to-shared-server" }
]);
export type MigrateTransition = z.infer<typeof migrateTransitionSchema>;

export const migrateOptionsSchema = z.object({
  slug: z.string().optional(),
  transition: migrateTransitionSchema.default({
    kind: "embedded-to-shared-server",
  }),
  dryRun: z.boolean().default(false),
  patchMetadata: z.boolean().default(true),
  staleThresholdSeconds: z.number().int().positive().default(3600),
});
export type MigrateOptions = z.input<typeof migrateOptionsSchema>;
export type ResolvedMigrateOptions = z.output<typeof migrateOptionsSchema>;

export const MIGRATE_REFUSAL_REASONS = [
  "slug-not-found",
  "not-embedded",
  "missing-jsonl",
  "stale-jsonl",
  "empty-workspace",
] as const;
export type MigrateRefusalReason = (typeof MIGRATE_REFUSAL_REASONS)[number];

export const MIGRATE_EVENT_NAMES = [
  "BD_MIGRATION_STARTED",
  "BD_MIGRATION_BACKUP_WRITTEN",
  "BD_MIGRATION_REINIT_COMPLETED",
  "BD_MIGRATION_METADATA_PATCHED",
  "BD_MIGRATION_VERIFIED",
  "BD_MIGRATION_COMPLETED",
  "BD_MIGRATION_FAILED",
] as const;
export type MigrateEventName = (typeof MIGRATE_EVENT_NAMES)[number];

export const migrateAppliedSchema = z.object({
  kind: z.literal("applied"),
  slug: z.string(),
  backupDir: z.string(),
  events: z.array(z.enum(MIGRATE_EVENT_NAMES)),
  patchedMetadata: z.boolean(),
  hint: z.string(),
});
export const migrateDryRunSchema = z.object({
  kind: z.literal("dry-run"),
  slug: z.string(),
  plannedSteps: z.array(z.string()),
  plannedBackupDir: z.string(),
});
export const migrateRefusedSchema = z.object({
  kind: z.literal("refused"),
  reason: z.enum(MIGRATE_REFUSAL_REASONS),
  detail: z.string().optional(),
  hint: z.string().optional(),
});
export const migrateFailedSchema = z.object({
  kind: z.literal("failed"),
  slug: z.string(),
  backupDir: z.string(),
  failedAt: z.enum(MIGRATE_EVENT_NAMES),
  detail: z.string(),
  events: z.array(z.enum(MIGRATE_EVENT_NAMES)),
});

export const migrateResultSchema = z.discriminatedUnion("kind", [
  migrateAppliedSchema,
  migrateDryRunSchema,
  migrateRefusedSchema,
  migrateFailedSchema,
]);
export type MigrateResult = z.infer<typeof migrateResultSchema>;

// ---- DI seam ---------------------------------------------------------------

export type MigrateRecordEvent = (
  event: MigrateEventName,
  opts?: { repo?: string; details?: Record<string, unknown> },
) => void;

export type MigrateDeps = {
  cwd?: string;
  homeDir?: string;
  runner?: BdMigrateRunner;
  recordEvent?: MigrateRecordEvent;
  now?: () => Date;
  /** Lookup hook — defaults to inventory-backed `localRepoForCwd` + slug match. */
  resolveRepo?: (slug: string | undefined, cwd: string) => LocalRepo | null;
};

// ---- runner ----------------------------------------------------------------

export function runBeadsMigrate(
  rawOpts: MigrateOptions,
  deps: MigrateDeps = {},
): MigrateResult {
  const opts = migrateOptionsSchema.parse(rawOpts);
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.homeDir ?? homedir();
  const now = deps.now ?? (() => new Date());
  const runner = deps.runner ?? defaultBdMigrateRunner;
  const recordEvent: MigrateRecordEvent =
    deps.recordEvent ??
    ((event, recordOpts) =>
      defaultRecordEvent(event, {
        ...(recordOpts?.repo ? { repo: recordOpts.repo } : {}),
        ...(recordOpts?.details ? { details: recordOpts.details } : {}),
        now,
      }));
  const resolveRepo = deps.resolveRepo ?? defaultResolveRepo;

  // 1. Resolve slug.
  const repo = resolveRepo(opts.slug, cwd);
  if (!repo) {
    return {
      kind: "refused",
      reason: "slug-not-found",
      detail: opts.slug
        ? `no registered repo with slug "${opts.slug}"`
        : `cwd ${cwd} does not match any registered repo`,
      hint: "list registered repos with `prx repo list`",
    };
  }
  const slug = repo.name;
  const repoRoot = repo.commonDir;
  const beadsDir = join(repoRoot, ".beads");

  // 2. Classify workspace.
  const mode = classifyBeadsWorkspace(repoRoot, { homeDir: home });
  if (mode.kind !== "embedded") {
    return {
      kind: "refused",
      reason: "not-embedded",
      detail: refusalDetailForMode(mode, slug),
      hint: refusalHintForMode(mode, slug),
    };
  }

  // 3. Pre-flight: jsonl presence + freshness + non-empty.
  const jsonlPath = join(beadsDir, "issues.jsonl");
  if (!existsSync(jsonlPath)) {
    return {
      kind: "refused",
      reason: "missing-jsonl",
      detail: `${jsonlPath} does not exist; bd export must seed it before migrate runs`,
      hint: "run `bd export > .beads/issues.jsonl` from inside the worktree",
    };
  }
  const jsonlStat = statSync(jsonlPath);
  if (jsonlStat.size === 0) {
    return {
      kind: "refused",
      reason: "empty-workspace",
      detail: `${jsonlPath} is empty; nothing to migrate`,
    };
  }
  const ageSeconds = Math.floor(
    (now().getTime() - jsonlStat.mtimeMs) / 1000,
  );
  if (ageSeconds > opts.staleThresholdSeconds) {
    return {
      kind: "refused",
      reason: "stale-jsonl",
      detail: `${jsonlPath} is ${ageSeconds}s old (> ${opts.staleThresholdSeconds}s); refresh before migrate to avoid losing in-flight rows`,
      hint: "run `bd export > .beads/issues.jsonl` then re-run migrate",
    };
  }

  // 4. Derive paths + bd args.
  const prefix = repo.bd_workspace_prefix;
  if (!prefix) {
    return {
      kind: "refused",
      reason: "slug-not-found",
      detail: `repo "${slug}" has no bd_workspace_prefix in the inventory; run \`prx repo backfill\` first`,
      hint: "run `prx repo backfill` to populate stale inventory entries",
    };
  }
  const backupDir = join(
    home,
    ".local",
    "state",
    "prx",
    "migrations",
    `${slug}-${isoTimestampForPath(now())}`,
  );
  const reinitArgs = [
    "bd",
    "init",
    "--reinit-local",
    "--discard-remote",
    "--shared-server",
    `--prefix=${prefix}`,
    "--stealth",
    "--from-jsonl",
    "--non-interactive",
    `--destroy-token=DESTROY-${prefix}`,
  ];
  const exportCmd = ["bd", "export"];
  const verifyShowCmd = ["bd", "dolt", "show"];
  const verifyListCmd = ["bd", "list", "--limit", "1"];

  // 5. Dry-run branch — describe planned steps, no on-disk effects.
  if (opts.dryRun) {
    const plannedSteps = [
      `mkdir -p ${backupDir}`,
      `${exportCmd.join(" ")} > ${join(backupDir, "issues.jsonl")}`,
      `cp -R ${beadsDir} ${join(backupDir, "beads-full")}`,
      reinitArgs.join(" "),
      ...(opts.patchMetadata
        ? [
            `patch-metadata: set ${join(beadsDir, "metadata.json")} dolt_mode=server`,
          ]
        : []),
      verifyShowCmd.join(" "),
      verifyListCmd.join(" "),
    ];
    return {
      kind: "dry-run",
      slug,
      plannedSteps,
      plannedBackupDir: backupDir,
    };
  }

  // 6. Apply branch.
  const emitted: MigrateEventName[] = [];
  const emit = (event: MigrateEventName, details?: Record<string, unknown>) => {
    recordEvent(event, { repo: slug, ...(details ? { details } : {}) });
    emitted.push(event);
  };

  mkdirSync(backupDir, { recursive: true });
  emit("BD_MIGRATION_STARTED", {
    transition: opts.transition.kind,
    backupDir,
  });

  // 6a. Backup: bd export → file, then full .beads/ copy.
  const exportRes = runner(exportCmd, { cwd: repoRoot });
  if (isCaptureFailure(exportRes)) {
    return failedResult({
      slug,
      backupDir,
      failedAt: "BD_MIGRATION_BACKUP_WRITTEN",
      detail: failureDetail("bd export", exportRes),
      emitted,
      emit,
    });
  }
  writeFileSync(join(backupDir, "issues.jsonl"), exportRes.stdout, "utf8");
  cpSync(beadsDir, join(backupDir, "beads-full"), { recursive: true });
  emit("BD_MIGRATION_BACKUP_WRITTEN", {
    backupJsonl: join(backupDir, "issues.jsonl"),
    backupTree: join(backupDir, "beads-full"),
  });

  // 6b. Destructive reinit.
  const reinitRes = runner(reinitArgs, { cwd: repoRoot });
  if (isCaptureFailure(reinitRes)) {
    return failedResult({
      slug,
      backupDir,
      failedAt: "BD_MIGRATION_REINIT_COMPLETED",
      detail: failureDetail("bd init --reinit-local", reinitRes),
      emitted,
      emit,
    });
  }
  emit("BD_MIGRATION_REINIT_COMPLETED");

  // 6c. Metadata patch (GH-1695 workaround, default on).
  if (opts.patchMetadata) {
    const patched = patchBeadsMetadataDoltMode(beadsDir);
    if (patched.ok) {
      emit("BD_MIGRATION_METADATA_PATCHED", { metadataPath: patched.metadataPath });
    } else {
      return failedResult({
        slug,
        backupDir,
        failedAt: "BD_MIGRATION_METADATA_PATCHED",
        detail: `failed to patch ${patched.metadataPath}: ${patched.error}`,
        emitted,
        emit,
      });
    }
  }

  // 6d. Verify: bd dolt show → server mode + bd list non-empty.
  const showRes = runner(verifyShowCmd, { cwd: repoRoot });
  if (isCaptureFailure(showRes)) {
    return failedResult({
      slug,
      backupDir,
      failedAt: "BD_MIGRATION_VERIFIED",
      detail: failureDetail("bd dolt show", showRes),
      emitted,
      emit,
    });
  }
  // Regex (not exact) — bd's show output format is version-coupled and a
  // strict literal would false-negative on minor format drift. The expected
  // post-state is the per-project Mode line (shared-server keeps the
  // per-project marker on the workspace; the dolt store moved out).
  if (!/Mode:\s*per-project/i.test(showRes.stdout)) {
    return failedResult({
      slug,
      backupDir,
      failedAt: "BD_MIGRATION_VERIFIED",
      detail: `bd dolt show did not report Mode: per-project; got:\n${showRes.stdout.trim() || "<empty stdout>"}`,
      emitted,
      emit,
    });
  }
  const listRes = runner(verifyListCmd, { cwd: repoRoot });
  if (isCaptureFailure(listRes) || listRes.stdout.trim().length === 0) {
    return failedResult({
      slug,
      backupDir,
      failedAt: "BD_MIGRATION_VERIFIED",
      detail: isCaptureFailure(listRes)
        ? failureDetail("bd list --limit 1", listRes)
        : "bd list --limit 1 returned no rows after migration",
      emitted,
      emit,
    });
  }
  emit("BD_MIGRATION_VERIFIED");

  emit("BD_MIGRATION_COMPLETED");

  return {
    kind: "applied",
    slug,
    backupDir,
    events: emitted,
    patchedMetadata: opts.patchMetadata,
    hint: `next: \`prx repo add-dolthub ${slug}\` (GH-1703) to wire the dolt remote, then \`prx repo gc ${slug}\` (GH-1700) to sweep orphans`,
  };
}

// ---- helpers ---------------------------------------------------------------

function defaultResolveRepo(
  slug: string | undefined,
  cwd: string,
): LocalRepo | null {
  if (!slug) {
    return localRepoForCwd(cwd);
  }
  const config = loadRepoInventoryConfig(cwd);
  if (!config.indexPath) return null;
  const inventory = loadRepoInventoryIndex(config.indexPath);
  if (!inventory) return null;
  for (const repo of inventory.repos) {
    if (repo.kind !== "bare") continue;
    if (repo.name === slug) return repo;
    if (repo.primaryRemote?.githubRepo === slug) return repo;
  }
  return null;
}

function refusalDetailForMode(mode: BeadsWorkspaceMode, slug: string): string {
  switch (mode.kind) {
    case "none":
      return `repo "${slug}" has no .beads/ subtree`;
    case "per_project":
      return `repo "${slug}" is already in per-project mode`;
    case "shared_server":
      return `repo "${slug}" is already in shared-server mode`;
    case "ambiguous":
      return `repo "${slug}" is in an ambiguous beads layout: ${mode.details}`;
    case "embedded":
      return `repo "${slug}" is embedded`;
  }
}

function refusalHintForMode(mode: BeadsWorkspaceMode, slug: string): string {
  switch (mode.kind) {
    case "shared_server":
      return `already migrated — try \`prx repo add-dolthub ${slug}\` (GH-1703) if the dolt remote isn't wired yet`;
    case "per_project":
      return `per-project repos do not yet have an automated migration; see GH-1706 v2`;
    case "ambiguous":
      return `run \`prx repo refresh ${slug}\` to hydrate the layout, then re-run migrate`;
    case "none":
      return `run \`prx beads-init\` first to seed .beads/`;
    case "embedded":
      return "";
  }
}

function failureDetail(verb: string, res: SpawnCaptureResult): string {
  const stderr = res.stderr.trim();
  const status = res.status ?? "?";
  if (res.error) return `${verb} failed: ${res.error.message}`;
  if (res.signal) return `${verb} killed by ${res.signal}`;
  return `${verb} exited ${status}${stderr ? `: ${stderr}` : ""}`;
}

function failedResult(args: {
  slug: string;
  backupDir: string;
  failedAt: MigrateEventName;
  detail: string;
  emitted: MigrateEventName[];
  emit: (event: MigrateEventName, details?: Record<string, unknown>) => void;
}): MigrateResult {
  args.emit("BD_MIGRATION_FAILED", {
    failedAt: args.failedAt,
    detail: args.detail,
    backupDir: args.backupDir,
  });
  return {
    kind: "failed",
    slug: args.slug,
    backupDir: args.backupDir,
    failedAt: args.failedAt,
    detail: args.detail,
    events: args.emitted,
  };
}

function isoTimestampForPath(d: Date): string {
  // Filesystem-safe ISO: drop ms + colons so the dir name is portable.
  return d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}
