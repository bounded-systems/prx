// `prx triage apply` (GH-919) — idempotent label-edit driver. Consumes a
// classifier plan (file or stdin) and reconciles each row's labels via the gh
// wrapper. Skips rows that already match (idempotent). Appends one JSONL row
// per write to ~/.cache/prx/triage/apply-<ISO>.jsonl.
//
// GH-971 / GH-2011 — when writes occur, chains the canonical reconcile
// (`runBeadsSync({ domain: "gh" })`) so the bd-canonical authority boundary
// is preserved. The destructive bd-side reconcile shell-out was retired in
// GH-2011 because it dropped bd-only writes for issue_type / assignee /
// state / close_reason.

import { processEnv } from "@bounded-systems/env";
import { readFileSync as defaultReadFileSync } from "node:fs";

import { z } from "zod";

import {
  proposedLabelsFor,
  validateLabelPlan,
  type LabelPlan,
  type LabelPlanRow,
} from "./label-vocab.ts";
import { BD_TYPE_ENUM, parseLabelName } from "./labels.ts";
import {
  execGh as defaultExecGh,
  fetchIssueLabels as defaultFetchIssueLabels,
  type GhExecResult,
} from "@bounded-systems/gh";
import { runBeadsSync as defaultRunBeadsSync, type BeadsSyncResult } from "../sync/run.ts";
import { DEFAULT_SYNC_LIMIT } from "../sync/limits.ts";
import { appendAuditRow, auditSinkPath, type AuditSinkDeps } from "../audit/sink.ts";

export const triageApplyOptionsSchema = z.object({
  plan: z.string().trim().min(1).optional(),
  dryRun: z.boolean().default(false),
  limit: z.number().int().min(0).default(0),
  repo: z.string().trim().min(1).optional(),
  sync: z.boolean().default(true),
});

export type TriageApplyOptions = z.infer<typeof triageApplyOptionsSchema>;

export type ReadTextFile = (path: string, encoding: "utf8") => string;

export type TriageApplyDeps = {
  execGh?: typeof defaultExecGh;
  readFileSync?: ReadTextFile;
  readStdin?: () => string;
  now?: () => Date;
  /** GH-1403 — sink-side DI for the unified daily NDJSON audit. */
  auditSink?: AuditSinkDeps;
  /**
   * GH-1697: routed cwd from `prx triage apply --repo <slug>`. Defaults to
   * `process.cwd()`. Mirrors the convention in `triage.ts` / `promote.ts`.
   */
  cwd?: () => string;
  /**
   * Canonical reconcile chained after label writes (GH-2011: replaces the
   * retired bd-side reconcile shell-out). Default delegates to
   * `defaultRunBeadsSync` so the sync runs against the current repo's beads
   * DB. Tests override this seam to assert chaining without spawning real
   * `gh` traffic.
   */
  runBeadsSync?: typeof defaultRunBeadsSync;
  /**
   * GH-1866 — batch-fetch live GH labels for the rows in the plan. Default
   * delegates to `fetchIssueLabels` (one aliased `gh api graphql` call).
   * `runTriageApply` invokes this once per pass before the write loop and
   * passes the per-row snapshot into `diffRow` so the per-axis gates reason
   * about what GH actually carries, not what bd's cache claims it carries.
   * Tests override this to inject deterministic snapshots without spawning
   * `gh`.
   */
  fetchLiveLabels?: (repo: string, numbers: number[]) => Map<number, string[]>;
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type ApplyDecision =
  | { kind: "skip"; row: LabelPlanRow; reason: "already-matches" }
  | {
      kind: "write";
      row: LabelPlanRow;
      addLabels: string[];
      removeLabels: string[];
      proposed: string[];
    };

export type ApplyAuditRowEntry = {
  ts: string;
  issue: number;
  url: string;
  action: "add-remove" | "skip" | "error";
  add: string[];
  remove: string[];
  prev: string[];
  proposed: string[];
  actor: "claude-code";
  dryRun: boolean;
  exitCode: number;
  stderr?: string;
};

export type ApplyAuditSyncEntry = {
  ts: string;
  action: "sync";
  touchedIssues: number[];
  actor: "claude-code";
  dryRun: false;
  bdExitCode: number;
  bdStdout: string;
  bdStderr?: string;
};

export type ApplyAuditEntry = ApplyAuditRowEntry | ApplyAuditSyncEntry;

export type ApplySyncOutcome = "ok" | "failed" | "skipped";

export function diffRow(row: LabelPlanRow, liveLabels?: readonly string[]): ApplyDecision {
  // GH-1866 — `liveLabels` is a fresh GH snapshot fetched by `runTriageApply`
  // immediately before the write loop. When present, all gate computations
  // (`hasType` / `hasPriority` / `hasArea` / `hasEffort`) and the proposed
  // label set are derived from it rather than the plan's bd-cache
  // `currentLabels`. The bd cache lags behind GH whenever an operator edits
  // labels directly; treating the stale cache as authoritative is what
  // stacked duplicate `type::*` labels on the 2026-05-16 incident issues.
  const source = liveLabels ?? row.currentLabels;
  const proposed = proposedLabelsFor(row, source);
  const current = new Set(source);
  const wanted = new Set(proposed);

  // GH-988 — symmetric mirror of the GH-1487 priority::none carve-out below.
  // `type::task` is the classifier's unscored fallback sentinel, not an
  // operator decision. `type::spike` is a GH-only marker (not in BD_TYPE_ENUM)
  // that rides alongside a bd-axis stamp; it does not count as the type-axis
  // decision either. Both are excluded from `hasType` so a scored type
  // emission strip-replaces them. Must stay in lock-step with the gate in
  // `proposedLabelsFor`.
  const hasType = source.some((l) => {
    const p = parseLabelName(l);
    return (
      p.known &&
      p.axis === "type" &&
      (BD_TYPE_ENUM as readonly string[]).includes(p.value) &&
      p.value !== "task"
    );
  });
  // GH-1487 — `priority::none` is the GH-970 unscored sentinel, not an
  // operator decision. Excluded from `hasPriority` so classifier upgrades
  // (`priority::high`, etc.) strip-and-replace it instead of being suppressed.
  // Must stay in lock-step with the gate in `proposedLabelsFor`.
  const hasPriority = source.some((l) => {
    const p = parseLabelName(l);
    return p.known && p.axis === "priority" && p.value !== "none";
  });
  const hasArea = source.some((l) => {
    const p = parseLabelName(l);
    return p.known && p.axis === "area";
  });
  const hasEffort = source.some((l) => {
    const p = parseLabelName(l);
    return p.known && p.axis === "effort";
  });

  const addLabels = proposed.filter((l) => !current.has(l));
  // GH-1866 — strip considers the union of plan-snapshot and live-snapshot
  // labels so a stale bd-side axis label that's already gone from GH is not
  // re-added by us, and any stale label present on either side is cleaned up.
  const stripUnion = new Set<string>(source);
  for (const l of row.currentLabels) stripUnion.add(l);
  const removeLabels = [...stripUnion].filter((l) => {
    if (wanted.has(l)) return false;
    // Per-axis strip (GH-952 + GH-957 + GH-1487 + GH-988): only remove stale
    // labels at axes the classifier emitted AND where no operator-set label
    // already exists. Existing axis labels are authoritative; classifier
    // output is suppressed there. The priority axis treats `priority::none`
    // as absent (sentinel, not a decision), so an upgrade strips it.
    // Similarly, the type axis treats `type::task` (unscored fallback
    // sentinel) as absent. `type::spike` is a GH-only marker (not in
    // BD_TYPE_ENUM); it never counts as the type-axis decision and is
    // preserved across strip — `proposedLabelsFor` re-projects it via
    // `row.spike`. Foreign labels (`needs-triage`, typos, etc.) are never
    // touched.
    if (row.type !== undefined && !hasType && l.startsWith("type::") && l !== "type::spike")
      return true;
    if (row.priority !== undefined && !hasPriority && l.startsWith("priority::")) return true;
    if (row.area !== undefined && !hasArea && l.startsWith("area::")) return true;
    if (row.effort !== undefined && !hasEffort && l.startsWith("effort::")) return true;
    return false;
  });

  if (addLabels.length === 0 && removeLabels.length === 0) {
    return { kind: "skip", row, reason: "already-matches" };
  }
  return { kind: "write", row, addLabels, removeLabels, proposed };
}

function loadPlan(
  source: string | undefined,
  deps: TriageApplyDeps,
  output: Output,
): LabelPlan | null {
  let raw: string;
  try {
    if (!source || source === "-") {
      const reader = deps.readStdin ?? readStdinSync;
      raw = reader();
    } else {
      const reader: ReadTextFile =
        deps.readFileSync ?? ((p, e) => defaultReadFileSync(p, e) as string);
      raw = reader(source, "utf8");
    }
  } catch (err) {
    output.error(`triage apply: failed to read plan: ${(err as Error).message}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    output.error(`triage apply: plan is not valid JSON`);
    return null;
  }
  try {
    return validateLabelPlan(parsed);
  } catch (err) {
    output.error(`triage apply: plan failed schema validation: ${(err as Error).message}`);
    return null;
  }
}

function readStdinSync(): string {
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.readFileSync(0, "utf8");
}

/**
 * Actor-shaped entry for `prx triage apply`. Captures stdout/stderr lines
 * and the audit JSONL rows the verb appends, so the machine can pull
 * `touchedIssues` straight off the result for downstream guards
 * (drift-fix) without re-reading disk.
 *
 * Audit NDJSON writes still hit disk via the underlying sink (`appendAuditRow`,
 * routed through `auditSink.appendFn` when injected). The wrapper only
 * intercepts to build the in-memory mirror.
 */
export type TriageApplyActorResult = {
  exitCode: number;
  audit: ApplyAuditEntry[];
  stdout: string[];
  stderr: string[];
  touchedIssues: number[];
};

export async function runApplyActor(
  opts: TriageApplyOptions,
  deps: TriageApplyDeps = {},
): Promise<TriageApplyActorResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const audit: ApplyAuditEntry[] = [];

  const upstreamAppend = deps.auditSink?.appendFn;
  const captureDeps: TriageApplyDeps = {
    ...deps,
    auditSink: {
      ...(deps.auditSink ?? {}),
      appendFn: (path, line) => {
        try {
          audit.push(JSON.parse(line.trim()) as ApplyAuditEntry);
        } catch {
          // ignore non-JSON lines
        }
        upstreamAppend?.(path, line);
      },
    },
  };
  const captureOutput: Output = {
    log: (line) => stdout.push(line),
    error: (line) => stderr.push(line),
  };

  const exitCode = await runTriageApply(opts, captureOutput, captureDeps);
  const touchedIssues = audit
    .filter((e): e is ApplyAuditRowEntry => e.action === "add-remove")
    .filter((e) => !e.dryRun)
    .map((e) => e.issue);
  return { exitCode, audit, stdout, stderr, touchedIssues };
}

export async function runTriageApply(
  opts: TriageApplyOptions,
  output: Output,
  deps: TriageApplyDeps = {},
): Promise<number> {
  const exec = deps.execGh ?? defaultExecGh;
  const now = (deps.now ?? (() => new Date()))();
  const auditSink: AuditSinkDeps = {
    ...(deps.auditSink ?? {}),
    now: deps.auditSink?.now ?? (() => now),
  };
  const append = (entry: ApplyAuditEntry): void => appendAuditRow(entry, auditSink);

  const plan = loadPlan(opts.plan, deps, output);
  if (!plan) return 1;

  const rows = opts.limit > 0 ? plan.rows.slice(0, opts.limit) : plan.rows;
  const logPath = auditSinkPath(now, {
    stateDirOverride: auditSink.stateDirOverride,
    env: auditSink.env,
  });

  // GH-1866 — batched live-GH label fetch. One `gh api graphql` aliased query
  // for every row in the plan, consumed by `diffRow` so the per-axis gates
  // reason about live GH state instead of the (often stale) bd-cache
  // `currentLabels` snapshot. Dry-run still fetches so the preview is honest.
  // Fail-closed: any fetch failure aborts the pass without writing labels —
  // falling back to `row.currentLabels` would silently re-enable the
  // stale-bd-vs-fresh-GH stacking bug this fix is meant to repair.
  const fetchLive = deps.fetchLiveLabels ?? defaultFetchIssueLabels;
  const numbers = rows.map((r) => r.number);
  let liveLabels: Map<number, string[]>;
  try {
    liveLabels = fetchLive(plan.repo, numbers);
  } catch (err) {
    output.error(
      `triage apply: live-label fetch failed: ${(err as Error).message}; aborting per GH-1866 fail-closed policy`,
    );
    return 2;
  }
  for (const row of rows) {
    if (!liveLabels.has(row.number)) {
      output.error(
        `triage apply: live-label fetch missing issue ${row.number}; aborting per GH-1866 fail-closed policy`,
      );
      return 2;
    }
  }

  let writes = 0;
  let skips = 0;
  let errors = 0;
  const touchedIssues: number[] = [];

  for (const row of rows) {
    const live = liveLabels.get(row.number)!;
    const decision = diffRow(row, live);
    if (decision.kind === "skip") {
      skips += 1;
      // GH-1866 — `prev` reflects the live GH snapshot, not the plan's stale
      // bd-cache labels. Downstream diff tooling that compared `prev` against
      // bd state needs to know the source changed under it.
      const entry: ApplyAuditEntry = {
        ts: now.toISOString(),
        issue: row.number,
        url: row.url,
        action: "skip",
        add: [],
        remove: [],
        prev: live,
        proposed: proposedLabelsFor(row, live),
        actor: "claude-code",
        dryRun: opts.dryRun,
        exitCode: 0,
      };
      append(entry);
      output.log(`skip GH-${row.number} (already matches)`);
      continue;
    }

    if (opts.dryRun) {
      const entry: ApplyAuditEntry = {
        ts: now.toISOString(),
        issue: row.number,
        url: row.url,
        action: "add-remove",
        add: decision.addLabels,
        remove: decision.removeLabels,
        prev: live,
        proposed: decision.proposed,
        actor: "claude-code",
        dryRun: true,
        exitCode: 0,
      };
      append(entry);
      const adds = decision.addLabels.length ? `+${decision.addLabels.join(",")}` : "";
      const rems = decision.removeLabels.length ? `-${decision.removeLabels.join(",")}` : "";
      output.log(`dry-run GH-${row.number} ${adds} ${rems}`.trim());
      writes += 1;
      continue;
    }

    const args: string[] = [String(row.number)];
    if (decision.addLabels.length > 0) {
      args.push("--add-label", decision.addLabels.join(","));
    }
    if (decision.removeLabels.length > 0) {
      args.push("--remove-label", decision.removeLabels.join(","));
    }
    if (opts.repo) {
      args.push("--repo", opts.repo);
    } else if (plan.repo) {
      args.push("--repo", plan.repo);
    }

    const result: GhExecResult = exec(
      {
        group: "issue",
        subcommand: "edit",
        args,
        state: "planning",
        role: "executor",
      },
      processEnv(),
    );

    const exitCode = result.exitCode;
    const ok = exitCode === 0;
    if (ok) {
      writes += 1;
      touchedIssues.push(row.number);
    } else {
      errors += 1;
    }

    const entry: ApplyAuditEntry = {
      ts: now.toISOString(),
      issue: row.number,
      url: row.url,
      action: ok ? "add-remove" : "error",
      add: decision.addLabels,
      remove: decision.removeLabels,
      prev: live,
      proposed: decision.proposed,
      actor: "claude-code",
      dryRun: false,
      exitCode,
      ...(ok ? {} : { stderr: result.stderr.trim() }),
    };
    append(entry);

    if (ok) {
      const adds = decision.addLabels.length ? `+${decision.addLabels.join(",")}` : "";
      const rems = decision.removeLabels.length ? `-${decision.removeLabels.join(",")}` : "";
      output.log(`apply GH-${row.number} ${adds} ${rems}`.trim());
    } else {
      output.error(`error GH-${row.number} exit=${exitCode}: ${result.stderr.trim()}`);
    }
  }

  // GH-971 / GH-2011 — chain the canonical reconcile so beads reflects the
  // GH-side status flips from the labels we just wrote. Skipped under
  // dry-run, when the operator opted out via `--no-sync`, or when no writes
  // occurred (nothing to reconcile).
  let syncOutcome: ApplySyncOutcome = "skipped";
  if (!opts.dryRun && opts.sync && writes > 0) {
    const beadsSync = deps.runBeadsSync ?? defaultRunBeadsSync;
    const syncCapture: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
    const syncOutput = {
      log: (line: string) => syncCapture.stdout.push(line),
      error: (line: string) => syncCapture.stderr.push(line),
    };
    const syncResult: BeadsSyncResult = await beadsSync(
      {
        repo: plan.repo,
        domain: "gh",
        dryRun: false,
        limit: DEFAULT_SYNC_LIMIT,
        format: "plain",
      },
      syncOutput,
    );
    const stderrTrimmed = syncCapture.stderr.join("\n").trim();
    const syncEntry: ApplyAuditSyncEntry = {
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
    `triage apply: writes=${writes} skips=${skips} errors=${errors} sync=${syncOutcome} log=${logPath}`,
  );

  if (syncOutcome === "failed") return 1;
  return errors > 0 ? 1 : 0;
}
