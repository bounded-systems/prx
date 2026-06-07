// `prx triage promote` (GH-936) — bulk GH→bd promotion of execution-ready
// issues. Two-phase, idempotent, mirrors `triage classify` / `triage apply`:
//
//   Phase 1: `prx triage promote`            — emit JSON plan to stdout (read-only).
//   Phase 2: `prx triage promote --from p.json [--dry-run] [--only N]` — walk plan.
//
// Closes the trio "classify → apply → promote" so promoting tens of issues no
// longer requires raw `bd create` loops, per the operator rule "bulk
// operations belong in prx verbs, not raw gh/bd/git loops".
//
// Selection rules (Phase 1):
//   - `skip:missing-labels`        — no `type::*` or no `priority::*` label.
//   - `skip:non-execution-type`    — type ∈ {spike, decision, epic, refactor}.
//                                    `refactor` is in the GH-918 vocab but not
//                                    in bd's `--type` enum (BD_TYPE_ENUM), so
//                                    it stays on the GH intake log.
//   - `skip:already-in-bd`         — beads has a record whose external_ref
//                                    points at this GH issue.
//   - `promote`                    — execution-ready (bug | feature | task |
//                                    chore) with both axes set, not yet in bd.
//
// Apply behavior (Phase 2): for each `decision: "promote"` row,
//   1. `bd create --silent --external-ref <url> --type <t> -p <n> --title <t>`
//      — captures the new bd ID from stdout.
//   2. `gh issue comment <n> --body "Promoted to beads as <bd-id>." --repo <r>`
//      — posts the pointer back to GH.
//   3. If bd succeeds but GH comment fails, log `partial-error` and continue.
//      Re-runs are idempotent: the next pass detects the bd row and skips.
//   4. `--dry-run` writes audit entries with `dryRun: true` and skips both
//      writes. `--only <n>` filters the plan to that GH issue number.
//
// NDJSON audit: routed through the unified daily sink at
// `$XDG_STATE_HOME/prx/audit/<YYYY-MM-DD>.ndjson` (GH-1403). One row per
// processed entry.

import { processEnv } from "@bounded-systems/env";
import { readFileSync as defaultReadFileSync } from "node:fs";

import { z } from "zod";

import {
  appendAuditRow,
  auditSinkPath,
  type AuditSinkDeps,
} from "../audit/sink.ts";

import {
  priorityLabelSchema,
  typeLabelSchema,
  type PriorityLabel,
  type TypeLabel,
} from "./label-vocab.ts";
import { parseLabelName } from "./labels.ts";
import {
  loadAllBeads,
  priorityToBdNumber,
  type BeadsRecord,
} from "./triage.ts";
import { execBd as defaultExecBd } from "@bounded-systems/bd";
import { defaultRunner as procRunner, type CommandRunner } from "@bounded-systems/proc";
import { execGh as defaultExecGh, type GhExecResult } from "@bounded-systems/gh";
import {
  buildBeadsLookup as buildBeadsLookupShared,
  lookupBead as lookupBeadShared,
  type BeadsLookup as SharedBeadsLookup,
} from "../issues/dedupe.ts";
import {
  repoNameWithOwner as defaultRepoNameWithOwner,
  type FallbackIssue,
} from "../pr-state/github.ts";
// GH-1602: substitute the gh-side `listOpenIssues` with the bd-resident
// projection. `pruneMergedActor` syncs bd from GH at the head of every triage
// pass, so promote's promotion queue is substrate-resident now.
import { listOpenIssuesFromBeads as defaultListOpenIssues } from "./issues-from-beads.ts";

export const triagePromoteOptionsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  dryRun: z.boolean().default(false),
  limit: z.number().int().min(0).default(0),
  only: z.number().int().positive().optional(),
});

export type TriagePromoteOptions = z.infer<typeof triagePromoteOptionsSchema>;

import {
  promoteDecisionSchema,
  type PromoteDecision,
} from "./schemas/decisions.ts";

export { promoteDecisionSchema };
export type { PromoteDecision };

// Subset of TYPE that bd accepts as a core `--type` value AND that we want in
// the execution queue. `epic` and `decision` are bd-acceptable but kept on the
// GH intake log; `spike` and `refactor` are not bd core types.
export const EXECUTION_READY_TYPES = ["bug", "feature", "task", "chore"] as const;
export type ExecutionReadyType = (typeof EXECUTION_READY_TYPES)[number];

export const promotePlanRowSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  type: typeLabelSchema.optional(),
  priority: priorityLabelSchema.optional(),
  decision: promoteDecisionSchema,
  reason: z.string(),
});

export type PromotePlanRow = z.infer<typeof promotePlanRowSchema>;

export const promotePlanSchema = z.object({
  repo: z.string().min(1),
  generatedAt: z.string(),
  rows: z.array(promotePlanRowSchema),
});

export type PromotePlan = z.infer<typeof promotePlanSchema>;

export type ReadTextFile = (path: string, encoding: "utf8") => string;

export type TriagePromoteDeps = {
  execBd?: typeof defaultExecBd;
  /** GH-296 / prx-82b — sync runner for the daemon-routed `prx beads create`. */
  run?: CommandRunner;
  execGh?: typeof defaultExecGh;
  listOpenIssues?: typeof defaultListOpenIssues;
  repoNameWithOwner?: typeof defaultRepoNameWithOwner;
  loadAllBeads?: (exec: typeof defaultExecBd) => BeadsRecord[];
  cwd?: () => string;
  now?: () => Date;
  readFileSync?: ReadTextFile;
  readStdin?: () => string;
  /** GH-1403 — sink-side DI for the unified daily NDJSON audit. */
  auditSink?: AuditSinkDeps;
  /**
   * GH-1595 — drop the per-invocation `BeadsCache` after each `bd create` in
   * the apply phase. Belt-and-suspenders: the apply loop doesn't re-read
   * beads today, but the cache shape protects future re-readers from a stale
   * snapshot mid-loop. Missing/no-op on test paths.
   */
  invalidateBeadsCache?: () => void;
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type PromoteAuditEntry = {
  ts: string;
  issue: number;
  url: string;
  action: "create" | "skip" | "partial-error" | "error";
  decision: PromoteDecision;
  type?: TypeLabel;
  priority?: PriorityLabel;
  beadId?: string;
  actor: "claude-code";
  dryRun: boolean;
  exitCode: number;
  stderr?: string;
};


function isExecutionReadyType(value: TypeLabel): value is ExecutionReadyType {
  return (EXECUTION_READY_TYPES as readonly string[]).includes(value);
}

// Promotion-eligible priorities exclude `none` (GH-970 unscored marker).
// Issues with only `priority::none` are operator-undecided and must not be
// promoted; they fall through to the `skip:missing-labels` branch.
type ScoredPriority = Exclude<PriorityLabel, "none">;

type ExtractedAxes = {
  type?: TypeLabel | undefined;
  priority?: ScoredPriority | undefined;
  hasMultiplePriority: boolean;
};

function extractAxes(labels: Iterable<{ name?: string | null } | null | undefined>): ExtractedAxes {
  let type: TypeLabel | undefined;
  const priorities = new Set<ScoredPriority>();
  for (const raw of labels) {
    const name = raw?.name;
    if (typeof name !== "string") continue;
    const parsed = parseLabelName(name);
    if (!parsed.known) continue;
    if (parsed.axis === "type") type = parsed.value as TypeLabel;
    else if (parsed.axis === "priority" && parsed.value !== "none") {
      priorities.add(parsed.value as ScoredPriority);
    }
  }
  const priority = priorities.size === 1 ? [...priorities][0] : undefined;
  return { type, priority, hasMultiplePriority: priorities.size > 1 };
}

export type BeadsLookup = SharedBeadsLookup;

export const buildBeadsLookup = buildBeadsLookupShared;

function lookupBead(issue: FallbackIssue, lookup: BeadsLookup): BeadsRecord | null {
  return lookupBeadShared({ number: issue.number, url: issue.url }, lookup);
}

export function selectDecision(
  issue: FallbackIssue,
  lookup: BeadsLookup,
): PromotePlanRow {
  const axes = extractAxes(issue.labels ?? []);
  const base = {
    number: issue.number,
    url: issue.url,
    title: issue.title,
  } as const;

  if (!axes.type && axes.hasMultiplePriority) {
    return {
      ...base,
      decision: "skip:missing-labels",
      reason: "no type::* and ambiguous priority::* labels",
    };
  }
  if (!axes.type) {
    return {
      ...base,
      decision: "skip:missing-labels",
      reason: "no type::* label",
    };
  }
  if (!axes.priority) {
    return {
      ...base,
      type: axes.type,
      decision: "skip:missing-labels",
      reason: axes.hasMultiplePriority
        ? "ambiguous priority::* labels"
        : "no priority::* label",
    };
  }

  const existing = lookupBead(issue, lookup);
  if (existing) {
    return {
      ...base,
      type: axes.type,
      priority: axes.priority,
      decision: "skip:already-in-bd",
      reason: `bd ${existing.id} already references this issue`,
    };
  }

  if (!isExecutionReadyType(axes.type)) {
    return {
      ...base,
      type: axes.type,
      priority: axes.priority,
      decision: "skip:non-execution-type",
      reason: `type::${axes.type} stays on GH intake log (not in bd execution-ready set)`,
    };
  }

  return {
    ...base,
    type: axes.type,
    priority: axes.priority,
    decision: "promote",
    reason: "execution-ready type with both axes set",
  };
}

export function buildPromotePlan(
  issues: FallbackIssue[],
  beads: BeadsRecord[],
  repo: string,
  generatedAt: string,
): PromotePlan {
  const lookup = buildBeadsLookup(beads);
  const rows = issues.map((issue) => selectDecision(issue, lookup));
  return promotePlanSchema.parse({ repo, generatedAt, rows });
}

function readStdinSync(): string {
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.readFileSync(0, "utf8");
}

function loadPlan(
  source: string | undefined,
  deps: TriagePromoteDeps,
  output: Output,
): PromotePlan | null {
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
    output.error(`triage promote: failed to read plan: ${(err as Error).message}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    output.error(`triage promote: plan is not valid JSON`);
    return null;
  }
  try {
    return promotePlanSchema.parse(parsed);
  } catch (err) {
    output.error(`triage promote: plan failed schema validation: ${(err as Error).message}`);
    return null;
  }
}

function runScanPhase(
  opts: TriagePromoteOptions,
  output: Output,
  deps: TriagePromoteDeps,
): number {
  const listIssues = deps.listOpenIssues ?? defaultListOpenIssues;
  const resolveRepo = deps.repoNameWithOwner ?? defaultRepoNameWithOwner;
  const bdExec = deps.execBd ?? defaultExecBd;
  const loadBeads = deps.loadAllBeads ?? loadAllBeads;
  const cwd = (deps.cwd ?? process.cwd)();
  const now = (deps.now ?? (() => new Date()))();

  const repo = opts.repo ?? resolveRepo(cwd);
  const ghLimit = opts.limit > 0 ? opts.limit : 1000;

  let issues: FallbackIssue[];
  try {
    issues = listIssues(repo, ghLimit);
  } catch (err) {
    output.error(`triage promote: failed to list issues: ${(err as Error).message}`);
    return 1;
  }

  let beads: BeadsRecord[];
  try {
    beads = loadBeads(bdExec);
  } catch (err) {
    output.error(`triage promote: ${(err as Error).message}`);
    return 1;
  }

  const plan = buildPromotePlan(issues, beads, repo, now.toISOString());
  output.log(JSON.stringify(plan, null, 2));
  return 0;
}

function runApplyPhase(
  opts: TriagePromoteOptions,
  output: Output,
  deps: TriagePromoteDeps,
): number {
  const exec = deps.execBd ?? defaultExecBd;
  const run = deps.run ?? procRunner;
  const ghExec = deps.execGh ?? defaultExecGh;
  const loadBeads = deps.loadAllBeads ?? loadAllBeads;
  const now = (deps.now ?? (() => new Date()))();
  const auditSink: AuditSinkDeps = {
    ...(deps.auditSink ?? {}),
    now: deps.auditSink?.now ?? (() => now),
  };
  const append = (entry: PromoteAuditEntry): void => appendAuditRow(entry, auditSink);

  const plan = loadPlan(opts.from, deps, output);
  if (!plan) return 1;

  let rows = plan.rows;
  if (opts.only !== undefined) {
    const only = opts.only;
    rows = rows.filter((row) => row.number === only);
  }
  if (opts.limit > 0) {
    rows = rows.slice(0, opts.limit);
  }

  const logPath = auditSinkPath(now, {
    stateDirOverride: auditSink.stateDirOverride,
    env: auditSink.env,
  });

  // Re-load beads once to short-circuit rows whose external_ref already
  // points into bd (the plan may have been generated against stale state).
  let beads: BeadsRecord[];
  try {
    beads = loadBeads(exec);
  } catch (err) {
    output.error(`triage promote: ${(err as Error).message}`);
    return 1;
  }
  const lookup = buildBeadsLookup(beads);

  let creates = 0;
  let skips = 0;
  let partials = 0;
  let errors = 0;

  for (const row of rows) {
    const baseEntry = {
      ts: now.toISOString(),
      issue: row.number,
      url: row.url,
      decision: row.decision,
      ...(row.type ? { type: row.type } : {}),
      ...(row.priority ? { priority: row.priority } : {}),
      actor: "claude-code" as const,
      dryRun: opts.dryRun,
    };

    if (row.decision !== "promote") {
      const entry: PromoteAuditEntry = {
        ...baseEntry,
        action: "skip",
        exitCode: 0,
      };
      append(entry);
      output.log(`skip GH-${row.number} (${row.decision})`);
      skips += 1;
      continue;
    }

    // Defensive idempotency: even if the plan says promote, re-check beads.
    const existing = lookupBead(
      { number: row.number, title: row.title, url: row.url, labels: [] },
      lookup,
    );
    if (existing) {
      const entry: PromoteAuditEntry = {
        ...baseEntry,
        action: "skip",
        decision: "skip:already-in-bd",
        beadId: existing.id,
        exitCode: 0,
      };
      append(entry);
      output.log(`skip GH-${row.number} (already-in-bd as ${existing.id})`);
      skips += 1;
      continue;
    }

    if (!row.type || !row.priority || row.priority === "none") {
      // Schema permits optional axes for skip rows; a promote row without
      // both is corrupt input — refuse rather than guess. priority::none
      // (GH-970) is the explicit unscored marker — a row in the promote-plan
      // tagged none means selection let it through (shouldn't happen post
      // GH-970), so refuse rather than promote with a guessed value.
      const entry: PromoteAuditEntry = {
        ...baseEntry,
        action: "error",
        exitCode: 1,
        stderr:
          row.priority === "none"
            ? "promote row has priority::none (operator-undecided)"
            : "promote row missing type or priority",
      };
      append(entry);
      output.error(
        `error GH-${row.number}: ${
          row.priority === "none"
            ? "promote row has priority::none (operator-undecided)"
            : "promote row missing type or priority"
        }`,
      );
      errors += 1;
      continue;
    }

    if (opts.dryRun) {
      const entry: PromoteAuditEntry = {
        ...baseEntry,
        action: "create",
        exitCode: 0,
      };
      append(entry);
      output.log(
        `dry-run GH-${row.number} bd create --type ${row.type} -p ${priorityToBdNumber(row.priority)}`,
      );
      creates += 1;
      continue;
    }

    // GH-296 / prx-82b: create via the daemon. `prx beads create` echoes the
    // created record as JSON; parse its id (no `--silent` id-line; `--priority`).
    const bdResult = run(
      [
        "prx",
        "beads",
        "create",
        "--external-ref",
        row.url,
        "--type",
        row.type,
        "--priority",
        String(priorityToBdNumber(row.priority)),
        "--title",
        row.title,
      ],
      { check: false },
    );

    if (bdResult.status !== 0) {
      const entry: PromoteAuditEntry = {
        ...baseEntry,
        action: "error",
        exitCode: bdResult.status,
        stderr: bdResult.stderr.trim() || bdResult.stdout.trim() || "prx beads create failed",
      };
      append(entry);
      output.error(
        `error GH-${row.number} prx beads create exit=${bdResult.status}: ${entry.stderr}`,
      );
      errors += 1;
      continue;
    }

    let beadId = "";
    try {
      const record = JSON.parse(bdResult.stdout) as { id?: unknown };
      if (typeof record.id === "string") beadId = record.id;
    } catch {
      beadId = "";
    }
    if (!beadId) {
      const entry: PromoteAuditEntry = {
        ...baseEntry,
        action: "error",
        exitCode: 1,
        stderr: "prx beads create returned no parseable id",
      };
      append(entry);
      output.error(`error GH-${row.number}: prx beads create returned no parseable id`);
      errors += 1;
      continue;
    }
    deps.invalidateBeadsCache?.();

    const commentResult: GhExecResult = ghExec(
      {
        group: "issue",
        subcommand: "comment",
        args: [
          String(row.number),
          "--body",
          `Promoted to beads as ${beadId}.`,
          "--repo",
          plan.repo,
        ],
        state: "planning",
        role: "executor",
      },
      processEnv(),
    );

    if (commentResult.exitCode !== 0) {
      const entry: PromoteAuditEntry = {
        ...baseEntry,
        action: "partial-error",
        beadId,
        exitCode: commentResult.exitCode,
        stderr: commentResult.stderr.trim() || "gh issue comment failed",
      };
      append(entry);
      output.error(
        `partial GH-${row.number}: bd row ${beadId} created but gh comment failed: ${entry.stderr}`,
      );
      partials += 1;
      continue;
    }

    const entry: PromoteAuditEntry = {
      ...baseEntry,
      action: "create",
      beadId,
      exitCode: 0,
    };
    append(entry);
    output.log(`create GH-${row.number} → ${beadId}`);
    creates += 1;
  }

  output.log(
    `triage promote: creates=${creates} skips=${skips} partials=${partials} errors=${errors} log=${logPath}`,
  );
  return errors > 0 || partials > 0 ? 1 : 0;
}

export function runTriagePromote(
  opts: TriagePromoteOptions,
  output: Output,
  deps: TriagePromoteDeps = {},
): number {
  if (opts.from) return runApplyPhase(opts, output, deps);
  return runScanPhase(opts, output, deps);
}

/**
 * Actor-shaped entry for `prx triage promote`. Two-phase like the verb:
 *   - Scan phase (no `from`): returns a typed PromotePlan via stdout-parsing.
 *   - Apply phase (`from` set): returns audit rows.
 * Captures stdout/stderr regardless.
 */
export type TriagePromoteActorResult = {
  exitCode: number;
  plan: PromotePlan | null;
  audit: PromoteAuditEntry[];
  stdout: string[];
  stderr: string[];
  promotedBeadIds: string[];
};

export function runPromoteActor(
  opts: TriagePromoteOptions,
  deps: TriagePromoteDeps = {},
): TriagePromoteActorResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const audit: PromoteAuditEntry[] = [];

  const upstreamAppend = deps.auditSink?.appendFn;
  const captureDeps: TriagePromoteDeps = {
    ...deps,
    auditSink: {
      ...(deps.auditSink ?? {}),
      appendFn: (path, line) => {
        try {
          audit.push(JSON.parse(line.trim()) as PromoteAuditEntry);
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

  const exitCode = runTriagePromote(opts, captureOutput, captureDeps);

  let plan: PromotePlan | null = null;
  if (!opts.from && exitCode === 0 && stdout.length > 0) {
    try {
      const parsed = JSON.parse(stdout.join("\n"));
      plan = promotePlanSchema.parse(parsed);
    } catch {
      plan = null;
    }
  }

  const promotedBeadIds = audit
    .filter((e) => e.action === "create" && !e.dryRun)
    .map((e) => e.beadId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  return { exitCode, plan, audit, stdout, stderr, promotedBeadIds };
}
