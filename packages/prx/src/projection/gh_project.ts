// GH-1510 Phase D — bd → GH-Projects projection writer.
//
// The bd graph is canonical for work-graph state (GH-1500 ADR v2). GH
// Projects is a downstream visualization that lags bd; this module
// **writes one direction**: bd → GH-Project. It never reads GH-Project
// fields back into the bd-canonical state. That direction-lock is I-PROJ1
// in `src/machine/state.ts`.
//
// Today the module composes a `ProjectionWriteReport` — a deterministic
// list of intended Status/Priority/Area field writes per GH item, plus
// before/after diffs. Live execution against `gh project item-edit` /
// the GraphQL mutation is gated on `--dry-run=false` at the CLI surface;
// the report is the same in both modes. A future ticket wires the live
// writer (GH-1537 sibling pattern).
//
// Boundary:
//   - Input  : NextWorkResult (the picker output validated through Zod).
//   - Output : ProjectionWriteReport (one row per GH item, action enum).

import { z } from "zod";

import type { NextWorkResult, NextWorkCandidate } from "../beads/ready.ts";
import type { GithubProjectConfig } from "../pr-state/github.ts";

// GH Project Status options the picker maps bd thread → project Status to.
// Kept open so a future bd-thread kind doesn't crash the writer at runtime
// — unknown kinds map to `Backlog` with a warning row instead.
export const ProjectionStatusSchema = z.enum([
  "Backlog",
  "Ready",
  "Blocked",
  "In Progress",
  "In Review",
  "Awaiting CI",
  "Done",
]);
export type ProjectionStatus = z.infer<typeof ProjectionStatusSchema>;

export const ProjectionFieldDiffSchema = z.object({
  field: z.enum(["Status", "Priority", "Area"]),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export type ProjectionFieldDiff = z.infer<typeof ProjectionFieldDiffSchema>;

export const ProjectionWriteRowSchema = z.object({
  bd_id: z.string().min(1),
  gh_issue: z.number().int().nullable(),
  thread: z.string().min(1),
  action: z.enum(["created", "updated", "unchanged", "skipped"]),
  diffs: z.array(ProjectionFieldDiffSchema),
  reason: z.string(),
});
export type ProjectionWriteRow = z.infer<typeof ProjectionWriteRowSchema>;

export const ProjectionWriteReportSchema = z.object({
  source: z.literal("projection.gh_project"),
  enabled: z.boolean(),
  project: z.object({
    owner: z.string().nullable(),
    number: z.number().int().nullable(),
  }),
  rows: z.array(ProjectionWriteRowSchema),
  // GH-1510 + GH-1537: GraphQL budget gate carries through to here so the
  // CLI verb can refuse to run a live write when budget is low.
  budget: z.object({
    requested: z.number().int().nonnegative(),
    threshold: z.number().int().nonnegative(),
  }),
});
export type ProjectionWriteReport = z.infer<typeof ProjectionWriteReportSchema>;

// The runner the CLI verb hands in. Today only used to fetch existing
// project-item field values when a live read is desired; the dry-run path
// produces deterministic `before=null` rows without touching gh.
export type GhRunner = (
  cmd: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; check?: boolean },
) => { exitCode: number; stdout: string; stderr: string };

function threadToStatus(thread: string): { status: ProjectionStatus; reason: string } {
  switch (thread) {
    case "ready_to_start":
      return { status: "Ready", reason: "bd ready; no blockers" };
    case "blocked":
      return { status: "Blocked", reason: "bd blocked_by open issue(s)" };
    case "executor_in_flight":
      return { status: "In Progress", reason: "executor in flight (committing/pushed/review)" };
    case "pr_awaiting_ci":
      return { status: "Awaiting CI", reason: "CI in flight on open PR" };
    case "orphan_cleanup":
      return { status: "Done", reason: "GH issue closed or PR merged — orphan artifacts" };
    case "triage_backlog":
    case "intake_queue":
      return { status: "Backlog", reason: "triage/intake backpressure" };
    case "plan_paused":
      return { status: "In Progress", reason: "plan contract exists, paused" };
    default:
      return { status: "Backlog", reason: `unmapped thread kind: ${thread}` };
  }
}

function priorityLabel(priority: number): string {
  switch (priority) {
    case 0:
      return "Critical";
    case 1:
      return "High";
    case 2:
      return "Medium";
    case 3:
      return "Low";
    default:
      return `P${priority}`;
  }
}

/**
 * Compose the bd→GH-Project write report from a picker result.
 *
 * Pure: this function never calls the gh runner. The runner argument is
 * threaded through so a future revision can fetch existing field values
 * for "unchanged vs updated" precision; the first cut emits all rows as
 * `updated` with `before=null`, matching the dry-run contract in the plan.
 *
 * When `config.owner` or `config.number` is null (no GH Project pinned in
 * `prx.toml`), the report comes back with `enabled=false` and zero rows
 * — the "no pin → zero ops" invariant from the GH-1500 ADR §1.
 */
export function projectBdToGhProject(
  result: NextWorkResult,
  config: GithubProjectConfig,
  _runner?: GhRunner,
  opts: { budget?: number; threshold?: number } = {},
): ProjectionWriteReport {
  const enabled = config.owner !== null && config.number !== null;
  const rows: ProjectionWriteRow[] = [];

  if (enabled) {
    for (const thread of result.threads) {
      const mapped = threadToStatus(thread.kind);
      for (const candidate of thread.candidates) {
        // I-PROJ1 guard rail (documentary, not testable here): this loop
        // ONLY reads `candidate` (which is bd-derived) — never the GhRunner.
        const diffs: ProjectionFieldDiff[] = [
          { field: "Status", before: null, after: mapped.status },
          { field: "Priority", before: null, after: priorityLabel(candidate.priority) },
        ];
        rows.push({
          bd_id: candidate.bd_id,
          gh_issue: candidate.gh_issue,
          thread: thread.kind,
          // First cut emits "updated" for every joined candidate; a live
          // read pass would refine to "unchanged" when before === after.
          action: candidate.gh_issue === null ? "skipped" : "updated",
          diffs,
          reason: candidate.gh_issue === null ? "no GH issue mirror" : mapped.reason,
        });
      }
    }
  }

  const report: ProjectionWriteReport = {
    source: "projection.gh_project",
    enabled,
    project: { owner: config.owner, number: config.number },
    rows,
    budget: {
      requested: rows.filter((r) => r.action === "updated").length,
      threshold: opts.threshold ?? 100,
    },
  };

  return ProjectionWriteReportSchema.parse(report);
}

export function formatProjectionReport(
  report: ProjectionWriteReport,
  format: "plain" | "json",
): string {
  if (format === "json") return JSON.stringify(report, null, 2);
  if (!report.enabled) {
    return "projection.gh_project: disabled (no [projection.gh_project] owner/number in prx.toml)";
  }
  const lines: string[] = [];
  lines.push(`projection.gh_project: ${report.project.owner}/${report.project.number}`);
  lines.push(`budget: ${report.budget.requested}/${report.budget.threshold}`);
  const counts = {
    updated: report.rows.filter((r) => r.action === "updated").length,
    skipped: report.rows.filter((r) => r.action === "skipped").length,
    unchanged: report.rows.filter((r) => r.action === "unchanged").length,
  };
  lines.push(
    `rows: ${counts.updated} updated, ${counts.skipped} skipped, ${counts.unchanged} unchanged`,
  );
  for (const row of report.rows.slice(0, 20)) {
    const ghPart = row.gh_issue !== null ? ` (GH-${row.gh_issue})` : "";
    const diffs = row.diffs.map((d) => `${d.field}=${d.after ?? "—"}`).join(", ");
    lines.push(`  ${row.action.padEnd(9)} ${row.bd_id}${ghPart} [${row.thread}] → ${diffs}`);
  }
  if (report.rows.length > 20) {
    lines.push(`  … +${report.rows.length - 20} more rows`);
  }
  return lines.join("\n");
}
