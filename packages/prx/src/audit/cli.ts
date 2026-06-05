// GH-1823 — `prx audit <verb>` CLI handlers.
//
// Three subverbs, all read-only:
//
//   prx audit ingest [--since=<ts>]
//     Refresh the SQLite metrics store from NDJSON + transition-log sources.
//     Idempotent; second invocation with no new disk rows is a no-op.
//
//   prx audit uow <id> [--format=text|json]
//     Per-UoW projection: artifact-chain status + invariant findings + the
//     `next_valid_action` derived from the first absent required slot.
//
//   prx audit system [--since=7d] [--format=text|json]
//     System rollup of the seven V1 metric views.
//
// No writes to bd / gh / git / worktree.

import { getEnv } from "@bounded-systems/env";
import type { Database } from "bun:sqlite";

import {
  type ArtifactType,
  artifactChainOrder,
  artifactTypeMeta,
  requiredArtifactTypesForPhase,
} from "./artifact-types.ts";
import { openAuditDb } from "./store/db.ts";
import { ingestAuditSources } from "./store/ingest.ts";

export type AuditCliDeps = {
  openDb?: typeof openAuditDb;
  /** Default audit + transition source dirs; tests inject fixture dirs. */
  auditDir?: string;
  transitionDir?: string;
  /** Override XDG_STATE_HOME walk for testing. */
  stateDirOverride?: string;
  /** Override the DB path. Tests use `:memory:`. Survives ingest+report flow. */
  db?: Database;
  now?: () => Date;
};

export type AuditOutput = {
  log: (line: string) => void;
  error: (line: string) => void;
};

// ─── ingest ───────────────────────────────────────────────────────────────

export type RunAuditIngestOptions = {
  since?: string;
  format?: "plain" | "json";
};

export function runAuditIngest(
  opts: RunAuditIngestOptions,
  output: AuditOutput,
  deps: AuditCliDeps = {},
): number {
  const db = deps.db ?? (deps.openDb ?? openAuditDb)({
    stateDirOverride: deps.stateDirOverride,
  });
  const result = ingestAuditSources(db, {
    since: opts.since,
    auditDir: deps.auditDir ?? resolveDefaultAuditDir(deps),
    transitionDir: deps.transitionDir ?? resolveDefaultTransitionDir(deps),
  });
  if (opts.format === "json") {
    output.log(JSON.stringify(result));
  } else {
    output.log(`ingested events=${result.eventsIngested} transitions=${result.transitionsIngested} uows=${result.uowsProjected} findings=${result.findingsWritten}`);
  }
  if (!deps.db) db.close();
  return 0;
}

// ─── uow ──────────────────────────────────────────────────────────────────

export type RunAuditUowOptions = {
  workUnitId: string;
  format?: "plain" | "json";
};

type SlotRow = {
  artifact_type: string;
  status: string;
  ref: string | null;
  input_refs_json: string;
  last_seen_ts: string | null;
};

type FindingRow = {
  invariant_id: string;
  status: string;
  detail_json: string;
};

export type AuditUowProjection = {
  uow_id: string;
  events_with_uow_id: { numerator: number; denominator: number; passed: boolean };
  artifact_chain: { type: string; status: string }[];
  ambient_git_operations: { count: number; passed: boolean };
  current_derived_phase: string;
  next_valid_action: string | null;
  findings: { invariant_id: string; status: string; message: string }[];
};

export function projectAuditUow(db: Database, uowId: string): AuditUowProjection {
  const ownedEvents = db
    .query<{ total: number }, [string]>(
      `SELECT COUNT(*) AS total FROM events WHERE uow_id = ?`,
    )
    .get(uowId) ?? { total: 0 };

  const slots = db
    .query<SlotRow, [string]>(
      `SELECT artifact_type, status, ref, input_refs_json, last_seen_ts
       FROM uow_artifacts
       WHERE uow_id = ?`,
    )
    .all(uowId);

  const slotIndex = new Map<string, SlotRow>(slots.map((s) => [s.artifact_type, s]));

  const chain = artifactChainOrder.map((type) => {
    const row = slotIndex.get(type);
    return { type, status: row?.status ?? "absent" };
  });

  const lastTransition = db
    .query<{ state_to: string }, [string]>(
      `SELECT state_to FROM transitions WHERE issue = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(uowId);
  const derivedPhase = lastTransition?.state_to ?? "no_transition";

  // next_valid_action: first absent required artifact in the chain order
  // (using the derived phase to decide what's required).
  const requiredNow = new Set<string>(
    requiredArtifactTypesForPhase(
      derivedPhase as Parameters<typeof requiredArtifactTypesForPhase>[0],
    ),
  );
  let nextAction: string | null = null;
  for (const type of artifactChainOrder) {
    const row = slotIndex.get(type);
    if (requiredNow.has(type) && (!row || row.status === "absent")) {
      nextAction = `create ${type} for ${uowId}`;
      break;
    }
  }

  const findings = db
    .query<FindingRow, [string]>(
      `SELECT invariant_id, status, detail_json
       FROM invariant_findings
       WHERE uow_id = ?
       ORDER BY id ASC`,
    )
    .all(uowId)
    .map((f) => {
      let message = "";
      try {
        const parsed = JSON.parse(f.detail_json) as { message?: unknown };
        if (typeof parsed.message === "string") message = parsed.message;
      } catch {
        // ignore
      }
      return { invariant_id: f.invariant_id, status: f.status, message };
    });

  const ambientGitForUow = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n
       FROM invariant_findings
       WHERE invariant_id = 'I-AUD4' AND uow_id = ?`,
    )
    .get(uowId) ?? { n: 0 };

  return {
    uow_id: uowId,
    events_with_uow_id: {
      numerator: ownedEvents.total,
      denominator: ownedEvents.total,
      passed: ownedEvents.total > 0,
    },
    artifact_chain: chain,
    ambient_git_operations: {
      count: ambientGitForUow.n,
      passed: ambientGitForUow.n === 0,
    },
    current_derived_phase: derivedPhase,
    next_valid_action: nextAction,
    findings,
  };
}

const chainGlyph = {
  absent: "·",
  pending: "…",
  present: "✓",
  passed: "✓",
  failed: "✗",
  blocked: "blocked",
  invalid_evidence: "✗",
} as const;

function formatChain(chain: readonly { type: string; status: string }[]): string {
  return chain
    .map((c) => `${shortType(c.type)} ${chainGlyph[c.status as keyof typeof chainGlyph] ?? c.status}`)
    .join(" ");
}

function shortType(type: string): string {
  // Title-case for the example output (`WorkMap`, `Delegation`, `Plan`, …).
  return type
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

export function renderAuditUowText(projection: AuditUowProjection): string[] {
  const lines: string[] = [];
  lines.push(`UoW: ${projection.uow_id}`);
  lines.push(
    `  events with uow_id: ${projection.events_with_uow_id.numerator}/${projection.events_with_uow_id.denominator} ${projection.events_with_uow_id.passed ? "passed" : "(no owned events)"}`,
  );
  lines.push(`  artifact chain: ${formatChain(projection.artifact_chain)}`);
  lines.push(
    `  ambient git operations: ${projection.ambient_git_operations.count} ${projection.ambient_git_operations.passed ? "passed" : "FAIL"}`,
  );
  lines.push(`  current derived phase: ${projection.current_derived_phase}`);
  if (projection.next_valid_action) {
    lines.push(`  next valid action: ${projection.next_valid_action}`);
  }
  if (projection.findings.length > 0) {
    lines.push(`  findings:`);
    for (const f of projection.findings) {
      lines.push(`    [${f.invariant_id}] ${f.message}`);
    }
  }
  return lines;
}

export function runAuditUow(
  opts: RunAuditUowOptions,
  output: AuditOutput,
  deps: AuditCliDeps = {},
): number {
  const db = deps.db ?? (deps.openDb ?? openAuditDb)({
    stateDirOverride: deps.stateDirOverride,
  });
  const projection = projectAuditUow(db, opts.workUnitId);
  if (opts.format === "json") {
    output.log(JSON.stringify(projection));
  } else {
    for (const line of renderAuditUowText(projection)) {
      output.log(line);
    }
  }
  if (!deps.db) db.close();
  return 0;
}

// ─── system ───────────────────────────────────────────────────────────────

export type RunAuditSystemOptions = {
  since?: string;
  format?: "plain" | "json";
};

const SYSTEM_VIEWS = [
  "v_uow_attachment_rate",
  "v_artifact_coverage_rate",
  "v_lineage_completeness_rate",
  "v_guarded_transition_rate",
  "v_ambient_git_violations",
  "v_patch_evidence_rate",
  "v_derivable_status_rate",
] as const;

export type SystemMetricRow = {
  metric: string;
  numerator: number;
  denominator: number;
  rate: number;
  target: number;
  met: number;
};

export function projectAuditSystem(db: Database): SystemMetricRow[] {
  const rows: SystemMetricRow[] = [];
  for (const view of SYSTEM_VIEWS) {
    const r = db.query<SystemMetricRow, []>(`SELECT * FROM ${view}`).get();
    if (r) rows.push(r);
  }
  return rows;
}

export function runAuditSystem(
  opts: RunAuditSystemOptions,
  output: AuditOutput,
  deps: AuditCliDeps = {},
): number {
  const db = deps.db ?? (deps.openDb ?? openAuditDb)({
    stateDirOverride: deps.stateDirOverride,
  });
  const rows = projectAuditSystem(db);
  if (opts.format === "json") {
    output.log(JSON.stringify({ since: opts.since ?? null, metrics: rows }));
  } else {
    output.log(`audit system metrics${opts.since ? ` (since ${opts.since})` : ""}`);
    for (const row of rows) {
      const ratePct = (row.rate * 100).toFixed(1);
      const targetPct = (row.target * 100).toFixed(1);
      const mark = row.met === 1 ? "OK" : "MISS";
      output.log(`  ${row.metric}: ${row.numerator}/${row.denominator} = ${ratePct}% (target ${targetPct}%) ${mark}`);
    }
  }
  if (!deps.db) db.close();
  return 0;
}

// ─── default-dir resolution ──────────────────────────────────────────────

function resolveDefaultAuditDir(deps: AuditCliDeps): string {
  const stateDir = deps.stateDirOverride
    ?? getEnv("XDG_STATE_HOME")
    ?? `${getEnv("HOME")}/.local/state`;
  return `${stateDir}/prx/audit`;
}

function resolveDefaultTransitionDir(deps: AuditCliDeps): string {
  const stateDir = deps.stateDirOverride
    ?? getEnv("XDG_STATE_HOME")
    ?? `${getEnv("HOME")}/.local/state`;
  return `${stateDir}/prx/transitions`;
}

// Required for downstream type re-use in cli.ts (silences unused-vars
// linter without an import cycle).
export type { ArtifactType };
export { artifactTypeMeta };
