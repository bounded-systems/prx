// GH-1701 — `prx repo audit` (fleet-wide beads-state inventory).
//
// Pure projection over a RepoInventory. Given `.prx/repos/index.json`
// already loaded, classify every entry into one of five beads-state
// arms and produce a row suitable for plain-text scanning or `--json`
// downstream tooling. Read-only by construction (I-RA1): the audit
// never writes `.beads/`, `.prx/`, dolt server state, or remote
// git/dolthub state.
//
// All FS / shell-out work is funnelled through the injected
// `RepoAuditDeps`, so the module is hermetic under unit test and the
// CLI wiring (src/pr-state/cli.ts) decides which real implementations
// to plug in.

import { z } from "zod";

import { buildDoltRemoteUrl, parseGitOrigin } from "../beads/hydrate.ts";
import type { BeadsWorkspaceMode } from "../beads/workspace_mode.ts";
import type { LocalRepo, RepoInventory } from "./repos.ts";

export const BEADS_STATE_VALUES = [
  "none",
  "embedded",
  "per-project",
  "shared-server",
  "ambiguous",
] as const;
export type BeadsState = (typeof BEADS_STATE_VALUES)[number];

export const MIGRATION_CANDIDATE_VALUES = [
  "bootstrap",
  "migrate",
  "add-dolthub",
  "repair",
  "none",
] as const;
export type MigrationCandidate = (typeof MIGRATION_CANDIDATE_VALUES)[number];

export type RepoAuditRow = {
  name: string;
  bd_workspace_prefix: string | null;
  commonDir: string;
  beads_state: BeadsState;
  dolt_remote: string | null;
  issue_count: number | "unknown";
  migration_candidate: MigrationCandidate;
};

export const repoAuditRowSchema = z.object({
  name: z.string().min(1),
  bd_workspace_prefix: z.string().nullable(),
  commonDir: z.string().min(1),
  beads_state: z.enum(BEADS_STATE_VALUES),
  dolt_remote: z.string().nullable(),
  issue_count: z.union([z.number().int().nonnegative(), z.literal("unknown")]),
  migration_candidate: z.enum(MIGRATION_CANDIDATE_VALUES),
});

export const repoAuditAdoptedSchema = z.object({
  repos: z.number().int().nonnegative(),
  branches: z.number().int().nonnegative(),
});
export type RepoAuditAdopted = z.infer<typeof repoAuditAdoptedSchema>;

export const repoAuditReportSchema = z.object({
  generatedAt: z.string().min(1),
  repos: z.array(repoAuditRowSchema),
  // GH-1760: row counts from the prx-wide sqlite registry sitting alongside
  // the JSON inventory. Optional so the schema parses on environments where
  // the registry file has never been created (count emits as 0).
  adopted: repoAuditAdoptedSchema.optional(),
});

export type RepoAuditReport = z.infer<typeof repoAuditReportSchema>;

// Deps take a `LocalRepo` (not a string) because per-project `.beads/` lives
// in the worktree, not in the bare commonDir. The dep implementation is
// responsible for picking the right inspection path (commonDir for bare repos
// with no worktree, the worktree path otherwise). Tests can fake any path.
export type RepoAuditDeps = {
  classify: (repo: LocalRepo) => BeadsWorkspaceMode;
  getGitOrigin: (repo: LocalRepo) => string | null;
  countIssues: (repo: LocalRepo) => number | null;
  dolthubOwner: string | null;
};

export function auditRegisteredRepos(
  inventory: RepoInventory,
  deps: RepoAuditDeps,
): RepoAuditRow[] {
  return inventory.repos.map((repo) => buildAuditRow(repo, deps));
}

function buildAuditRow(repo: LocalRepo, deps: RepoAuditDeps): RepoAuditRow {
  const mode = deps.classify(repo);
  const beads_state = beadsStateForMode(mode);

  // GH-1703: prefer the persisted Dolthub URL when present (operator's
  // `prx repo add-dolthub` wired the remote, possibly with a `--name`
  // override). Fall back to deriving from origin for unwired repos so the
  // audit can still surface a candidate URL alongside the `"add-dolthub"`
  // migration recommendation.
  const originUrl = deps.getGitOrigin(repo);
  const components = originUrl ? parseGitOrigin(originUrl) : null;
  const derivedDoltRemote = components ? buildDoltRemoteUrl(components, deps.dolthubOwner) : null;
  const dolt_remote = repo.dolt_remote ?? derivedDoltRemote;

  const issue_count =
    beads_state === "none" || beads_state === "ambiguous"
      ? "unknown"
      : (deps.countIssues(repo) ?? "unknown");

  return {
    name: repo.name,
    bd_workspace_prefix: repo.bd_workspace_prefix ?? null,
    commonDir: repo.commonDir,
    beads_state,
    dolt_remote,
    issue_count,
    // GH-1703: the migration_candidate signal is "is this repo *wired*", not
    // "do we have a URL to recommend". Pass the persisted value (not the
    // merged one) so per-project repos with no `dolt_remote` keep surfacing
    // `"add-dolthub"` even when origin parses cleanly.
    migration_candidate: migrationCandidateFor(beads_state, repo.dolt_remote ?? null),
  };
}

function beadsStateForMode(mode: BeadsWorkspaceMode): BeadsState {
  switch (mode.kind) {
    case "none":
      return "none";
    case "embedded":
      return "embedded";
    case "per_project":
      return "per-project";
    case "shared_server":
      return "shared-server";
    case "ambiguous":
      return "ambiguous";
  }
}

function migrationCandidateFor(state: BeadsState, doltRemote: string | null): MigrationCandidate {
  switch (state) {
    case "none":
      return "bootstrap";
    case "embedded":
      return "migrate";
    case "per-project":
      return doltRemote === null ? "add-dolthub" : "none";
    case "shared-server":
      return "none";
    case "ambiguous":
      return "repair";
  }
}

export function formatRepoAudit(
  rows: RepoAuditRow[],
  format: "plain" | "json",
  generatedAt: string,
  adopted?: RepoAuditAdopted,
): string {
  const report: RepoAuditReport = adopted
    ? { generatedAt, repos: rows, adopted }
    : { generatedAt, repos: rows };
  // Validate before printing so a regression in a probe helper surfaces here
  // (schema boundary, per the GH-1701 state-machine framing).
  repoAuditReportSchema.parse(report);

  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }

  const lines: string[] = [
    `Repo audit (${rows.length} repo${rows.length === 1 ? "" : "s"})`,
    "=====================",
    `Generated: ${generatedAt}`,
  ];
  if (adopted) {
    // GH-1760: surface the prx-wide registry counts so the operator can spot
    // drift between `.prx/repos/index.json` and `registry.sqlite` at a glance.
    lines.push(`adopted (registry.sqlite): ${adopted.repos} repos, ${adopted.branches} branches`);
  }
  lines.push("");

  if (rows.length === 0) {
    lines.push("No repos registered in .prx/repos/index.json.");
    return lines.join("\n");
  }

  for (const row of rows) {
    const prefix = row.bd_workspace_prefix ?? "none";
    lines.push(`${row.name} [prefix=${prefix}]`);
    lines.push(`  state: ${row.beads_state}`);
    lines.push(`  remote: ${row.dolt_remote ?? "(none)"}`);
    lines.push(`  issues: ${row.issue_count === "unknown" ? "unknown" : row.issue_count}`);
    lines.push(`  migration: ${row.migration_candidate}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
