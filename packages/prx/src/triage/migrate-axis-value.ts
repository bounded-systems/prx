// `prx triage migrate-axis-value` (GH-1059) — bulk swap an out-of-vocab
// `<axis>::<from>` label to an in-vocab `<axis>::<to>` label across open
// issues. Single-phase, dry-run by default, idempotent on re-run.
//
// Motivating use case: GH-1050 / #1058 narrowed the canonical `TYPE` Zod enum
// to bd's round-trippable subset (`bug, feature, task, chore, epic`). Open
// issues still carrying `type::decision` / `type::refactor` need to be
// relabeled onto in-vocab values. (`type::spike` was re-added to the GH-only
// projection of `TYPE` by GH-1489 — `prx intake spike` stamps it alongside
// the bd-axis `type::task`, and the verb is still useful for migrating any
// other out-of-vocab axis values that surface.) Per the operator norm
// `feedback_bulk_ops_via_prx`, a sweep of >~3 writes belongs in a typed prx
// verb — this is that verb.
//
// Decision rule per open issue:
//   - migrate                 — issue carries `<axis>::<from>` ⇒ remove it,
//                              add `<axis>::<to>`, post one-line audit comment.
//   - (filtered)              — issue does not carry `<axis>::<from>` ⇒ not
//                              emitted in the plan at all (re-run path).
//
// Apply behavior (mirrors `triage apply`, GH-919/971):
//   1. `gh issue edit <n> --add-label <to> --remove-label <from> --repo <r>`.
//   2. `gh issue comment <n> --body "Migrated label ... (GH-1059)." --repo <r>`.
//   3. NDJSON audit row appended to the unified daily sink at
//      `$XDG_STATE_HOME/prx/audit/<YYYY-MM-DD>.ndjson` (GH-1403).
//   4. After all rows (writes > 0, --no-sync not set), run the canonical
//      status-only reconcile `runBeadsSync` (the sanctioned `prx sync issues
//      --from gh --to bd` surface) so beads reflects the GH state we just
//      edited. GH-2316 retired the destructive bd-side reconcile shell-out
//      here so a `priority::*` label can never round-trip into bd-canonical
//      priority (I-DS-PRIO).
//
// Idempotency: a successful migration removes the `from` label, so re-running
// the same invocation lists zero migrate rows and exits 0 without writes.

import { processEnv } from "@bounded-systems/env";
import { z } from "zod";

import {
  appendAuditRow,
  auditSinkPath,
  type AuditSinkDeps,
} from "../audit/sink.ts";

import { LABEL_AXES, labelName, type LabelAxis } from "./labels.ts";
import {
  AREA,
  EFFORT,
  PRIORITY,
  TYPE,
} from "./labels.ts";
import { execGh as defaultExecGh, type GhExecResult } from "@bounded-systems/gh";
import {
  runBeadsSync as defaultRunBeadsSync,
  type BeadsSyncResult,
} from "../sync/run.ts";
import { DEFAULT_SYNC_LIMIT } from "../sync/limits.ts";
import {
  repoNameWithOwner as defaultRepoNameWithOwner,
  type FallbackIssue,
} from "../pr-state/github.ts";
// GH-1602: substitute the gh-side `listOpenIssues` with the bd-resident
// projection. `pruneMergedActor` syncs bd from GH at the head of every triage
// pass, so migrate-axis-value's queue enumeration is substrate-resident now.
import { listOpenIssuesFromBeads as defaultListOpenIssues } from "./issues-from-beads.ts";

export const labelAxisSchema = z.enum(LABEL_AXES as readonly [LabelAxis, ...LabelAxis[]]);

const AXIS_TO_ENUM: Record<LabelAxis, z.ZodEnum<[string, ...string[]]>> = {
  type: TYPE,
  priority: PRIORITY,
  area: AREA,
  effort: EFFORT,
};

// `from` is intentionally an arbitrary string: the whole point of the verb is
// to migrate values that have already been removed from the canonical Zod
// vocab. `to` must validate against the chosen axis enum, and `from !== to`.
export const triageMigrateAxisValueOptionsSchema = z
  .object({
    axis: labelAxisSchema,
    from: z.string().trim().min(1),
    to: z.string().trim().min(1),
    repo: z.string().trim().min(1).optional(),
    apply: z.boolean().default(false),
    limit: z.number().int().min(0).default(0),
    sync: z.boolean().default(true),
  })
  .superRefine((opts, ctx) => {
    if (opts.from === opts.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "--from and --to must differ",
        path: ["to"],
      });
    }
    const enumSchema = AXIS_TO_ENUM[opts.axis];
    if (!enumSchema.safeParse(opts.to).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `--to "${opts.to}" is not a valid value for axis "${opts.axis}" (allowed: ${enumSchema.options.join(", ")})`,
        path: ["to"],
      });
    }
  });

export type TriageMigrateAxisValueOptions = z.infer<
  typeof triageMigrateAxisValueOptionsSchema
>;

export const migrateDecisionSchema = z.enum(["migrate"]);
export type MigrateDecision = z.infer<typeof migrateDecisionSchema>;

export const migratePlanRowSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  currentLabels: z.array(z.string()),
  fromLabel: z.string().min(1),
  toLabel: z.string().min(1),
  decision: migrateDecisionSchema,
  reason: z.string(),
});

export type MigratePlanRow = z.infer<typeof migratePlanRowSchema>;

export const migratePlanSchema = z.object({
  repo: z.string().min(1),
  axis: labelAxisSchema,
  from: z.string().min(1),
  to: z.string().min(1),
  generatedAt: z.string(),
  rows: z.array(migratePlanRowSchema),
});

export type MigratePlan = z.infer<typeof migratePlanSchema>;

export type TriageMigrateAxisValueDeps = {
  execGh?: typeof defaultExecGh;
  listOpenIssues?: typeof defaultListOpenIssues;
  repoNameWithOwner?: typeof defaultRepoNameWithOwner;
  cwd?: () => string;
  now?: () => Date;
  /** GH-1403 — sink-side DI for the unified daily NDJSON audit. */
  auditSink?: AuditSinkDeps;
  /**
   * Canonical reconcile chained after label writes (GH-2316: replaces the
   * retired destructive bd-side reconcile shell-out; the sanctioned surface
   * is `prx sync issues --from gh --to bd`). Default delegates to
   * `defaultRunBeadsSync`.
   */
  runBeadsSync?: typeof defaultRunBeadsSync;
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type MigrateAuditRowEntry = {
  ts: string;
  issue: number;
  url: string;
  axis: LabelAxis;
  from: string;
  to: string;
  action: "edit" | "skip" | "partial-error" | "error";
  prev: string[];
  actor: "claude-code";
  dryRun: boolean;
  exitCode: number;
  stderr?: string;
};

export type MigrateAuditSyncEntry = {
  ts: string;
  action: "sync";
  touchedIssues: number[];
  actor: "claude-code";
  dryRun: false;
  bdExitCode: number;
  bdStdout: string;
  bdStderr?: string;
};

export type MigrateAuditEntry = MigrateAuditRowEntry | MigrateAuditSyncEntry;

export type MigrateSyncOutcome = "ok" | "failed" | "skipped";


function issueLabelNames(issue: FallbackIssue): string[] {
  return (issue.labels ?? [])
    .map((label) => label?.name)
    .filter((name): name is string => typeof name === "string");
}

// Pure decision per issue. Returns null when the issue does not carry the
// `from` label — those issues are filtered out before plan emission so the
// plan only describes work to do.
export function selectMigrateDecision(
  issue: FallbackIssue,
  axis: LabelAxis,
  from: string,
  to: string,
): MigratePlanRow | null {
  const fromLabel = labelName(axis, from);
  const toLabel = labelName(axis, to);
  const labels = issueLabelNames(issue);
  if (!labels.includes(fromLabel)) return null;

  const alsoHasTo = labels.includes(toLabel);
  return {
    number: issue.number,
    url: issue.url,
    title: issue.title,
    currentLabels: labels,
    fromLabel,
    toLabel,
    decision: "migrate",
    reason: alsoHasTo
      ? `issue carries both ${fromLabel} and ${toLabel}; stripping ${fromLabel}`
      : `issue carries ${fromLabel}; swapping to ${toLabel}`,
  };
}

export function buildMigratePlan(
  issues: FallbackIssue[],
  repo: string,
  axis: LabelAxis,
  from: string,
  to: string,
  generatedAt: string,
): MigratePlan {
  const rows: MigratePlanRow[] = [];
  for (const issue of issues) {
    const row = selectMigrateDecision(issue, axis, from, to);
    if (row) rows.push(row);
  }
  return migratePlanSchema.parse({ repo, axis, from, to, generatedAt, rows });
}

function commentBody(axis: LabelAxis, from: string, to: string): string {
  return `Migrated label \`${labelName(axis, from)}\` → \`${labelName(axis, to)}\` (GH-1059).`;
}

export async function runTriageMigrateAxisValue(
  opts: TriageMigrateAxisValueOptions,
  output: Output,
  deps: TriageMigrateAxisValueDeps = {},
): Promise<number> {
  const listIssues = deps.listOpenIssues ?? defaultListOpenIssues;
  const resolveRepo = deps.repoNameWithOwner ?? defaultRepoNameWithOwner;
  const exec = deps.execGh ?? defaultExecGh;
  const cwd = (deps.cwd ?? process.cwd)();
  const now = (deps.now ?? (() => new Date()))();
  const auditSink: AuditSinkDeps = {
    ...(deps.auditSink ?? {}),
    now: deps.auditSink?.now ?? (() => now),
  };
  const append = (entry: MigrateAuditEntry): void =>
    appendAuditRow(entry, auditSink);

  const repo = opts.repo ?? resolveRepo(cwd);

  let issues: FallbackIssue[];
  try {
    issues = listIssues(repo, 1000);
  } catch (err) {
    output.error(`triage migrate-axis-value: failed to list issues: ${(err as Error).message}`);
    return 1;
  }

  const plan = buildMigratePlan(issues, repo, opts.axis, opts.from, opts.to, now.toISOString());

  if (!opts.apply) {
    output.log(JSON.stringify(plan, null, 2));
    return 0;
  }

  // --limit caps the number of migrate rows processed, not the GH fetch window.
  let rows = plan.rows;
  if (opts.limit > 0) rows = rows.slice(0, opts.limit);

  const logPath = auditSinkPath(now, {
    stateDirOverride: auditSink.stateDirOverride,
    env: auditSink.env,
  });

  let writes = 0;
  let skips = 0;
  let partials = 0;
  let errors = 0;
  const touchedIssues: number[] = [];
  const body = commentBody(opts.axis, opts.from, opts.to);

  for (const row of rows) {
    const baseEntry = {
      ts: now.toISOString(),
      issue: row.number,
      url: row.url,
      axis: opts.axis,
      from: opts.from,
      to: opts.to,
      prev: row.currentLabels,
      actor: "claude-code" as const,
      dryRun: false,
    };

    const editArgs = [
      String(row.number),
      "--add-label",
      row.toLabel,
      "--remove-label",
      row.fromLabel,
      "--repo",
      plan.repo,
    ];

    const editResult: GhExecResult = exec(
      {
        group: "issue",
        subcommand: "edit",
        args: editArgs,
        state: "planning",
        role: "executor",
      },
      processEnv(),
    );

    if (editResult.exitCode !== 0) {
      const entry: MigrateAuditRowEntry = {
        ...baseEntry,
        action: "error",
        exitCode: editResult.exitCode,
        stderr: editResult.stderr.trim() || "gh issue edit failed",
      };
      append(entry);
      output.error(`error GH-${row.number} gh issue edit exit=${editResult.exitCode}: ${entry.stderr}`);
      errors += 1;
      continue;
    }

    const commentResult: GhExecResult = exec(
      {
        group: "issue",
        subcommand: "comment",
        args: [String(row.number), "--body", body, "--repo", plan.repo],
        state: "planning",
        role: "executor",
      },
      processEnv(),
    );

    if (commentResult.exitCode !== 0) {
      const entry: MigrateAuditRowEntry = {
        ...baseEntry,
        action: "partial-error",
        exitCode: commentResult.exitCode,
        stderr: commentResult.stderr.trim() || "gh issue comment failed",
      };
      append(entry);
      output.error(`partial GH-${row.number}: label swap ok but gh comment failed: ${entry.stderr}`);
      // The label edit succeeded — count it as a touch so the post-loop sync
      // still reconciles bd's issue_type column for this issue.
      touchedIssues.push(row.number);
      partials += 1;
      continue;
    }

    const entry: MigrateAuditRowEntry = {
      ...baseEntry,
      action: "edit",
      exitCode: 0,
    };
    append(entry);
    output.log(`apply GH-${row.number} +${row.toLabel} -${row.fromLabel}`);
    writes += 1;
    touchedIssues.push(row.number);
  }

  // GH-2316 — canonical status-only reconcile; the destructive
  // `--pull-only --prefer-github` shell-out was retired so a `priority::*`
  // label can no longer round-trip into bd-canonical priority (I-DS-PRIO).
  let syncOutcome: MigrateSyncOutcome = "skipped";
  if (opts.sync && touchedIssues.length > 0) {
    const beadsSync = deps.runBeadsSync ?? defaultRunBeadsSync;
    const syncCapture: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
    const syncOutput = {
      log: (line: string) => syncCapture.stdout.push(line),
      error: (line: string) => syncCapture.stderr.push(line),
    };
    const syncResult: BeadsSyncResult = await beadsSync(
      {
        repo,
        domain: "gh",
        dryRun: false,
        limit: DEFAULT_SYNC_LIMIT,
        format: "plain",
      },
      syncOutput,
    );
    const stderrTrimmed = syncCapture.stderr.join("\n").trim();
    const syncEntry: MigrateAuditSyncEntry = {
      ts: now.toISOString(),
      action: "sync",
      touchedIssues,
      actor: "claude-code",
      dryRun: false,
      bdExitCode: syncResult.exitCode,
      bdStdout: syncCapture.stdout.join("\n").trim(),
      ...(stderrTrimmed.length > 0 ? { bdStderr: stderrTrimmed } : {}),
    };
    append(syncEntry);

    if (syncResult.exitCode === 0) {
      syncOutcome = "ok";
      output.log(`OK bd github sync: ${touchedIssues.length} issue(s) reconciled`);
    } else {
      syncOutcome = "failed";
      const detail = stderrTrimmed || syncCapture.stdout.join("\n").trim();
      output.error(detail ? `FAIL bd github sync: ${detail}` : "FAIL bd github sync");
    }
  }

  output.log(
    `triage migrate-axis-value: writes=${writes} skips=${skips} partials=${partials} errors=${errors} sync=${syncOutcome} log=${logPath}`,
  );

  if (syncOutcome === "failed") return 1;
  return errors > 0 || partials > 0 ? 1 : 0;
}
