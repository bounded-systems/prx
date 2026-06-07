// `prx triage close-stale` (GH-1782) — bulk-close beads whose linked GH issue
// is already closed. Iterates `prx triage status`'s `stale` projection (open
// bd, closed GH) and writes each bd row to `closed` via the planner-tier
// `bd update -s closed --notes …` chain. One-shot only; bd-only write.
//
// Direction-lock: writes bd only. No GH state is mutated — the GH issue is
// already closed by definition of the `stale` projection. The verb is the
// action-counterpart to `triage status`'s `stale` bucket. Resolves the
// bulk-ops policy violation that previously forced operators to run raw
// `bd update -s closed` per bead to clear the stale backlog.
//
// Reason axis (`--reason {completed,not-planned,duplicate}`, default
// `completed`) shares vocabulary with `prx triage close` and `prx plan close`
// via `triageCloseReasonSchema`. Default differs from `triage close`'s
// `not-planned` because "GH issue closed → PR merged → work shipped" is the
// dominant cause of a stale bead.
//
// **Out of scope (see the issue body):**
//   - Reverse-orphan close (already `prx triage close` — GH-1719).
//   - Bd dedupe by `external_ref` — GH-1255. A stale bead may in fact be a
//     duplicate of a still-open bead; the default `completed` reason is wrong
//     in that case. Operator should re-classify per row with the existing
//     `prx triage close --reason duplicate` if caught.
//   - Two-phase `--from plan.json` scan/replay. Drift-fix has it for
//     vocab-boundary skips; close-stale's only decision is `--reason`, which
//     is a CLI flag.
//   - `bd github sync` chain after writes. GH is already closed — there is
//     nothing to pull.

import { z } from "zod";

import {
  appendAuditRow,
  auditSinkPath,
  type AuditSinkDeps,
} from "../audit/sink.ts";
import { execBd as defaultExecBd } from "@bounded-systems/bd";
import { defaultRunner as procRunner, type CommandRunner } from "@bounded-systems/proc";
import { triageCloseStaleAuditRowSchema } from "./schemas/audit.ts";

import {
  triageCloseReasonSchema,
  buildClosedNotePrefixed,
  type TriageCloseReason,
} from "./close.ts";
import { findStaleProjection, type StaleRow } from "./triage.ts";

export const triageCloseStaleOptionsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  reason: triageCloseReasonSchema.default("completed"),
  note: z.string().trim().min(1).optional(),
  dryRun: z.boolean().default(false),
  limit: z.number().int().min(0).default(0),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type TriageCloseStaleOptions = z.infer<typeof triageCloseStaleOptionsSchema>;

export type TriageCloseStaleResultRow = {
  beadsId: string;
  issueNumber: number;
  url: string;
  reason: TriageCloseReason;
  closed: boolean;
  dryRun: boolean;
  refusalReason: string | null;
};

export type TriageCloseStaleResult = {
  rows: TriageCloseStaleResultRow[];
  writes: number;
  skips: number;
  errors: number;
  logPath: string;
};

export type TriageCloseStaleAuditEntry = z.infer<typeof triageCloseStaleAuditRowSchema>;

export type TriageCloseStaleDeps = {
  execBd?: typeof defaultExecBd;
  /**
   * GH-296 / prx-82b — sync runner for the daemon-routed close write
   * (`prx beads close <id> --reason …`), so the stale-close mutates the one
   * beads the daemon owns instead of host `bd` against a per-clone .beads.
   * Default: procRunner; tests inject a capturing fake.
   */
  run?: CommandRunner;
  cwd?: () => string;
  now?: () => Date;
  /** Sink-side DI for the unified daily NDJSON audit. */
  auditSink?: AuditSinkDeps;
  /**
   * GH-1595: invalidate the per-invocation beads cache after each successful
   * `bd update -s closed`. Wired by the CLI dispatch; missing/no-op on test
   * paths that supply their own bd-exec fake.
   */
  invalidateBeadsCache?: () => void;
  /**
   * Source of stale rows. Defaults to `findStaleProjection` (the gh-canonical
   * slice of `runTriageStatus`). Tests inject a synthetic projection so they
   * don't have to stand up the open/closed-issue GH fetch.
   */
  findStale?: (opts: { repo: string | undefined; cwd?: () => string }) => {
    repo: string;
    canonical: "gh" | "bd";
    rows: StaleRow[];
  };
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

function defaultFindStale(deps: TriageCloseStaleDeps) {
  return (opts: { repo: string | undefined; cwd?: () => string }) =>
    findStaleProjection(
      { ...(opts.repo !== undefined ? { repo: opts.repo } : {}) },
      {
        ...(deps.execBd ? { execBd: deps.execBd } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      },
    );
}

export function runTriageCloseStale(
  opts: TriageCloseStaleOptions,
  output: Output,
  deps: TriageCloseStaleDeps = {},
): TriageCloseStaleResult {
  const run = deps.run ?? procRunner;
  const now = (deps.now ?? (() => new Date()))();
  const auditSink: AuditSinkDeps = {
    ...(deps.auditSink ?? {}),
    now: deps.auditSink?.now ?? (() => now),
  };
  const logPath = auditSinkPath(now, {
    stateDirOverride: auditSink.stateDirOverride,
    env: auditSink.env,
  });

  const findStale = deps.findStale ?? defaultFindStale(deps);

  // GH-1804: per-row + summary progress lines are suppressed on `--format=json`
  // so stdout stays a single parseable JSON document (the CLI emits one
  // `formatTriageCloseStaleResult(result, "json")` blob after the verb returns).
  // Errors stay on `output.error` (stderr) regardless of format.
  const logProgress = opts.format === "plain" ? output.log : () => {};

  let stale: { repo: string; canonical: "gh" | "bd"; rows: StaleRow[] };
  try {
    stale = findStale({ repo: opts.repo, ...(deps.cwd ? { cwd: deps.cwd } : {}) });
  } catch (err) {
    output.error(`triage close-stale: ${(err as Error).message}`);
    return { rows: [], writes: 0, skips: 0, errors: 1, logPath };
  }

  if (stale.canonical === "bd") {
    output.error(
      "triage close-stale: bd-canonical repo has no 'gh-issue-closed' stale "
      + "axis (use `prx triage status` for the bd-canonical stale bucket)",
    );
    return { rows: [], writes: 0, skips: 0, errors: 1, logPath };
  }

  let rows = stale.rows;
  if (opts.limit > 0) rows = rows.slice(0, opts.limit);

  const resultRows: TriageCloseStaleResultRow[] = [];
  let writes = 0;
  let skips = 0;
  let errors = 0;

  for (const row of rows) {
    const noteBody = buildClosedNotePrefixed(
      "prx triage close-stale",
      opts.reason,
      opts.note,
    );

    if (opts.dryRun) {
      const entry: TriageCloseStaleAuditEntry = {
        ts: now.toISOString(),
        issue: row.issueNumber,
        beadsId: row.beadsId,
        action: "update",
        reason: opts.reason,
        url: row.url,
        note: noteBody,
        actor: "claude-code",
        dryRun: true,
        exitCode: 0,
      };
      appendAuditRow(entry, auditSink);
      logProgress(
        `dry-run ${row.beadsId} GH-${row.issueNumber} close (reason=${opts.reason})`,
      );
      resultRows.push({
        beadsId: row.beadsId,
        issueNumber: row.issueNumber,
        url: row.url,
        reason: opts.reason,
        closed: false,
        dryRun: true,
        refusalReason: null,
      });
      writes += 1;
      continue;
    }

    // GH-296 / prx-82b: close via the daemon (single writer). `prx beads close`
    // maps to `bd update <id> --status closed --notes <reason>` daemon-side.
    const result = run(
      ["prx", "beads", "close", row.beadsId, "--reason", noteBody],
      { check: false },
    );

    if (result.status !== 0) {
      const detail =
        result.stderr.trim() || result.stdout.trim() || `prx beads close exit=${result.status}`;
      const entry: TriageCloseStaleAuditEntry = {
        ts: now.toISOString(),
        issue: row.issueNumber,
        beadsId: row.beadsId,
        action: "error",
        reason: opts.reason,
        url: row.url,
        note: noteBody,
        actor: "claude-code",
        dryRun: false,
        exitCode: result.status,
        stderr: detail,
      };
      appendAuditRow(entry, auditSink);
      output.error(
        `error ${row.beadsId} GH-${row.issueNumber} prx beads close exit=${result.status}: ${detail}`,
      );
      resultRows.push({
        beadsId: row.beadsId,
        issueNumber: row.issueNumber,
        url: row.url,
        reason: opts.reason,
        closed: false,
        dryRun: false,
        refusalReason: detail,
      });
      errors += 1;
      continue;
    }

    const entry: TriageCloseStaleAuditEntry = {
      ts: now.toISOString(),
      issue: row.issueNumber,
      beadsId: row.beadsId,
      action: "update",
      reason: opts.reason,
      url: row.url,
      note: noteBody,
      actor: "claude-code",
      dryRun: false,
      exitCode: 0,
    };
    appendAuditRow(entry, auditSink);
    deps.invalidateBeadsCache?.();
    logProgress(`closed ${row.beadsId} GH-${row.issueNumber} (reason=${opts.reason})`);
    resultRows.push({
      beadsId: row.beadsId,
      issueNumber: row.issueNumber,
      url: row.url,
      reason: opts.reason,
      closed: true,
      dryRun: false,
      refusalReason: null,
    });
    writes += 1;
  }

  logProgress(
    `triage close-stale: writes=${writes} skips=${skips} errors=${errors} reason=${opts.reason} log=${logPath}`,
  );

  return { rows: resultRows, writes, skips, errors, logPath };
}

export function formatTriageCloseStaleResult(
  result: TriageCloseStaleResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  // Plain output is already streamed line-by-line through `output.log` during
  // the run; the summary line is the final user-facing artifact.
  return "";
}
