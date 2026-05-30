// GH-1823 — audit-store ingester.
//
// Pulls rows from two on-disk sources into the SQLite metrics store:
//
//   1. `~/.local/state/prx/audit/<DATE>.ndjson` — unified audit sink rows
//      (GH-1403, `src/audit/sink.ts`).
//   2. Per-issue transition logs — `TransitionEntry` JSONL files
//      (`src/pr-state/transition_log.ts`).
//
// Idempotent: events are upserted by a synthetic `event_id` derived from
// `(source, ts, actor, action, uow_id)`; transitions are keyed by their
// JSONL `id` field. A second invocation with no new disk rows is a no-op.
//
// After upserting raw rows, the ingester projects per-UoW artifact slots
// and runs the five I-AUD predicates, writing findings into
// `invariant_findings`.

import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ArtifactSlot, ArtifactType } from "../artifact-types.ts";
import {
  artifactStatusValues,
  artifactTypeNames,
} from "../artifact-types.ts";
import {
  type AuditEvent,
  type GuardedTransition,
  assertArtifactLineage,
  assertDerivedStatus,
  assertGuardedTransition,
  assertNoAmbientGit,
  assertUowAttachment,
} from "../invariants.ts";

export type IngestSources = {
  /** Directory containing `<YYYY-MM-DD>.ndjson` files. */
  auditDir?: string;
  /** Directory containing per-issue `<GH-N>.jsonl` transition logs. */
  transitionDir?: string;
};

export type IngestOptions = IngestSources & {
  /** ISO timestamp floor. Rows older than this are skipped. */
  since?: string | undefined;
};

export type IngestResult = {
  eventsIngested: number;
  transitionsIngested: number;
  uowsProjected: number;
  findingsWritten: number;
};

// ─── Row mapping ──────────────────────────────────────────────────────────

type RawAuditRow = Record<string, unknown>;

/**
 * Derive the synthetic uow_id for an audit row. Prefers `uow_id` if present,
 * else `issue` (GH-rooted units), else `workUnitId` (machine inspector
 * rows), else `null` (unattached — fuel for the I-AUD1 finding).
 */
function rowUowId(row: RawAuditRow): string | null {
  const direct = row.uow_id ?? row.workUnitId ?? row.issue;
  if (direct == null) return null;
  if (typeof direct === "string" && direct.length > 0) return direct;
  if (typeof direct === "number") return `GH-${direct}`;
  return null;
}

function rowActor(row: RawAuditRow): string {
  const a = row.actor;
  return typeof a === "string" && a.length > 0 ? a : "unknown";
}

function rowAction(row: RawAuditRow): string {
  // The machine event rows use `event` (e.g. PUSH_COMMIT); per-verb rows
  // use `action`. The legacy sink also writes some rows with `kind`. Fall
  // back across all three so the ambient-git check sees raw verbs and the
  // uow-attachment check sees something stable.
  const action = row.action ?? row.event ?? row.kind ?? "";
  return typeof action === "string" ? action : String(action);
}

function rowTimestamp(row: RawAuditRow): string {
  const t = row.ts;
  return typeof t === "string" ? t : new Date(0).toISOString();
}

function rowArtifactType(row: RawAuditRow): string | null {
  const t = row.artifact_type;
  if (typeof t === "string" && (artifactTypeNames as readonly string[]).includes(t)) {
    return t;
  }
  return null;
}

function rowArtifactRef(row: RawAuditRow): string | null {
  const r = row.artifact_ref;
  return typeof r === "string" ? r : null;
}

function rowInputRefs(row: RawAuditRow): string[] {
  const raw = row.input_refs;
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  return [];
}

function syntheticEventId(source: string, row: RawAuditRow): string {
  const ts = rowTimestamp(row);
  const actor = rowActor(row);
  const action = rowAction(row);
  const uow = rowUowId(row) ?? "";
  const extra = (row.event_id as string | undefined) ?? "";
  return `${source}::${ts}::${actor}::${action}::${uow}::${extra}`;
}

// ─── Disk readers ─────────────────────────────────────────────────────────

function readNdjsonLines(path: string): RawAuditRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as RawAuditRow;
      } catch {
        return null;
      }
    })
    .filter((r): r is RawAuditRow => r !== null);
}

function listAuditFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ndjson"))
    .map((f) => join(dir, f))
    .sort();
}

function listTransitionFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .sort();
}

// ─── Upsert helpers ───────────────────────────────────────────────────────

function upsertEvent(db: Database, source: string, row: RawAuditRow): boolean {
  const event_id = syntheticEventId(source, row);
  const ts = rowTimestamp(row);
  const actor = rowActor(row);
  const action = rowAction(row);
  const uow_id = rowUowId(row);
  const artifact_type = rowArtifactType(row);
  const artifact_ref = rowArtifactRef(row);
  const raw_json = JSON.stringify(row);

  const existing = db
    .query("SELECT 1 FROM events WHERE event_id = ?")
    .get(event_id);
  if (existing) return false;

  db.run(
    `INSERT INTO events (event_id, ts, actor, action, uow_id, artifact_type, artifact_ref, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [event_id, ts, actor, action, uow_id, artifact_type, artifact_ref, raw_json],
  );
  return true;
}

type TransitionRow = {
  id: string;
  issue: string | null;
  state_from: string;
  state_to: string;
  actor: string;
  artifact: string | null;
  ts: string;
  proof_commit: string | null;
  proof_checks_json: string | null;
};

function parseTransition(raw: RawAuditRow): TransitionRow | null {
  if (typeof raw.id !== "string") return null;
  if (typeof raw.state_from !== "string" || typeof raw.state_to !== "string") return null;
  const proof = raw.proof as { commit?: unknown; checks?: unknown } | undefined;
  return {
    id: raw.id,
    issue: typeof raw.issue === "string" ? raw.issue : null,
    state_from: raw.state_from,
    state_to: raw.state_to,
    actor: typeof raw.actor === "string" ? raw.actor : "unknown",
    artifact: typeof raw.artifact === "string" ? raw.artifact : null,
    ts: typeof raw.timestamp === "string"
      ? raw.timestamp
      : (typeof raw.ts === "string" ? raw.ts : new Date(0).toISOString()),
    proof_commit: typeof proof?.commit === "string" ? proof.commit : null,
    proof_checks_json: Array.isArray(proof?.checks) ? JSON.stringify(proof.checks) : null,
  };
}

function upsertTransition(db: Database, t: TransitionRow): boolean {
  const existing = db.query("SELECT 1 FROM transitions WHERE id = ?").get(t.id);
  if (existing) return false;
  db.run(
    `INSERT INTO transitions (id, issue, state_from, state_to, actor, artifact, ts, proof_commit, proof_checks_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t.id, t.issue, t.state_from, t.state_to, t.actor, t.artifact, t.ts, t.proof_commit, t.proof_checks_json],
  );
  return true;
}

// ─── Slot projection ──────────────────────────────────────────────────────

type StatusValue = (typeof artifactStatusValues)[number];

function slotStatusFromAction(action: string): StatusValue {
  // Light heuristic — the verbs that emit per-type artifacts decide their
  // own outcome state. Tests cover the cases that matter for V1.
  if (action.endsWith(".failed") || action.endsWith("_FAILED")) return "failed";
  if (action.endsWith(".blocked") || action.endsWith("_BLOCKED")) return "blocked";
  if (action.endsWith(".passed") || action.endsWith("_PASSED")) return "passed";
  return "present";
}

function projectSlotsFromEvents(db: Database): Map<string, ArtifactSlot[]> {
  const rows = db
    .query<
      {
        ts: string;
        uow_id: string | null;
        artifact_type: string | null;
        artifact_ref: string | null;
        action: string;
        raw_json: string;
      },
      []
    >(
      `SELECT ts, uow_id, artifact_type, artifact_ref, action, raw_json
       FROM events
       WHERE artifact_type IS NOT NULL`,
    )
    .all();

  const byUow = new Map<string, Map<ArtifactType, ArtifactSlot>>();
  for (const row of rows) {
    if (row.uow_id === null) continue;
    const type = row.artifact_type as ArtifactType;
    if (!(artifactTypeNames as readonly string[]).includes(type)) continue;

    let parsed: RawAuditRow = {};
    try {
      parsed = JSON.parse(row.raw_json) as RawAuditRow;
    } catch {
      // ignore — fall back to defaults
    }
    const input_refs = rowInputRefs(parsed);

    const slot: ArtifactSlot = {
      type,
      status: slotStatusFromAction(row.action),
      ref: row.artifact_ref,
      uow_id: row.uow_id,
      input_refs,
      last_seen_ts: row.ts,
    };

    const inner = byUow.get(row.uow_id) ?? new Map();
    const existing = inner.get(type);
    if (!existing || (existing.last_seen_ts ?? "") <= slot.last_seen_ts!) {
      inner.set(type, slot);
    }
    byUow.set(row.uow_id, inner);
  }

  const result = new Map<string, ArtifactSlot[]>();
  for (const [uow, inner] of byUow) {
    result.set(uow, [...inner.values()]);
  }
  return result;
}

function writeSlots(db: Database, slots: ArtifactSlot[]): void {
  const upsert = db.prepare(
    `INSERT INTO uow_artifacts (uow_id, artifact_type, status, ref, input_refs_json, last_seen_ts)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(uow_id, artifact_type) DO UPDATE SET
       status = excluded.status,
       ref = excluded.ref,
       input_refs_json = excluded.input_refs_json,
       last_seen_ts = excluded.last_seen_ts`,
  );
  for (const s of slots) {
    upsert.run(
      s.uow_id,
      s.type,
      s.status,
      s.ref,
      JSON.stringify(s.input_refs),
      s.last_seen_ts,
    );
  }
}

// ─── Findings ─────────────────────────────────────────────────────────────

function writeFindings(
  db: Database,
  ts: string,
  findings: ReadonlyArray<{ id: string; severity: string; message: string; uow_id?: string | null }>,
): number {
  if (findings.length === 0) return 0;
  const insert = db.prepare(
    `INSERT INTO invariant_findings (uow_id, invariant_id, status, detail_json, ts)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const f of findings) {
    insert.run(
      f.uow_id ?? null,
      f.id,
      f.severity,
      JSON.stringify({ message: f.message }),
      ts,
    );
  }
  return findings.length;
}

function selectEventsForInvariants(db: Database): AuditEvent[] {
  return db
    .query<
      { ts: string; uow_id: string | null; actor: string; action: string; artifact_type: string | null },
      []
    >(
      `SELECT ts, uow_id, actor, action, artifact_type FROM events`,
    )
    .all()
    .map((r) => ({
      ts: r.ts,
      uow_id: r.uow_id,
      actor: r.actor,
      action: r.action,
      artifact_type: r.artifact_type,
    }));
}

function selectTransitionsForGuards(db: Database): GuardedTransition[] {
  const rows = db
    .query<
      { issue: string | null; state_from: string; state_to: string; ts: string },
      []
    >(
      `SELECT issue, state_from, state_to, ts FROM transitions ORDER BY ts ASC`,
    )
    .all();
  const out: GuardedTransition[] = [];
  for (const r of rows) {
    if (r.issue === null) continue;
    // Snapshot of artifact types present for this UoW at or before the
    // transition. For V1 simplicity we use the current uow_artifacts row;
    // history-aware snapshotting lands with GH-1821's TransitionContract.
    const present = db
      .query<{ artifact_type: string }, [string, string]>(
        `SELECT artifact_type FROM uow_artifacts
         WHERE uow_id = ?
           AND status IN ('present','passed')
           AND (last_seen_ts IS NULL OR last_seen_ts <= ?)`,
      )
      .all(r.issue, r.ts);
    out.push({
      uow_id: r.issue,
      state_from: r.state_from,
      state_to: r.state_to,
      present_artifact_types: present.map((p) => p.artifact_type),
    });
  }
  return out;
}

// ─── Public entrypoint ────────────────────────────────────────────────────

export function ingestAuditSources(db: Database, opts: IngestOptions = {}): IngestResult {
  const auditDir = opts.auditDir;
  const transitionDir = opts.transitionDir;
  const sinceTs = opts.since ?? "0000-01-01T00:00:00.000Z";

  // 1) NDJSON events.
  let eventsIngested = 0;
  if (auditDir) {
    for (const file of listAuditFiles(auditDir)) {
      const rows = readNdjsonLines(file);
      for (const row of rows) {
        if (rowTimestamp(row) < sinceTs) continue;
        if (upsertEvent(db, file, row)) eventsIngested++;
      }
    }
  }

  // 2) Transition log entries.
  let transitionsIngested = 0;
  if (transitionDir) {
    for (const file of listTransitionFiles(transitionDir)) {
      const rows = readNdjsonLines(file);
      for (const row of rows) {
        const t = parseTransition(row);
        if (!t) continue;
        if (t.ts < sinceTs) continue;
        if (upsertTransition(db, t)) transitionsIngested++;
      }
    }
  }

  // 3) Slot projection from accumulated events.
  const slotsByUow = projectSlotsFromEvents(db);
  for (const slots of slotsByUow.values()) {
    writeSlots(db, slots);
  }

  // 4) Run predicates and record findings. We clear stale rows first so
  //    re-ingestion converges to current truth instead of accumulating.
  db.run("DELETE FROM invariant_findings");
  const now = new Date().toISOString();

  const events = selectEventsForInvariants(db);
  let findingsWritten = 0;
  findingsWritten += writeFindings(
    db,
    now,
    assertUowAttachment(events).map((f) => ({ ...f, uow_id: null })),
  );
  findingsWritten += writeFindings(
    db,
    now,
    assertNoAmbientGit(events).map((f) => ({ ...f, uow_id: null })),
  );

  for (const [uow, slots] of slotsByUow) {
    findingsWritten += writeFindings(
      db,
      now,
      assertArtifactLineage(slots).map((f) => ({ ...f, uow_id: uow })),
    );
  }

  const transitions = selectTransitionsForGuards(db);
  for (const t of transitions) {
    findingsWritten += writeFindings(
      db,
      now,
      assertGuardedTransition(t).map((f) => ({ ...f, uow_id: t.uow_id })),
    );
  }

  // I-AUD5: compare recorded status (most recent transition state_to) with
  // derived phase. For V1, the derived phase is the same most-recent
  // state_to (no separate "recorded" field exists in current data), so
  // mismatches only arise from injected divergence in tests. The check
  // stays in place so GH-1822's typed `status` field gets measured the
  // moment it lands.
  for (const uow of slotsByUow.keys()) {
    const last = db
      .query<{ state_to: string }, [string]>(
        `SELECT state_to FROM transitions WHERE issue = ? ORDER BY ts DESC LIMIT 1`,
      )
      .get(uow);
    const recordedRow = db
      .query<{ raw_json: string }, [string]>(
        `SELECT raw_json FROM events
         WHERE uow_id = ? AND action = 'status_recorded'
         ORDER BY ts DESC LIMIT 1`,
      )
      .get(uow);
    let recorded_status: string | null = null;
    if (recordedRow) {
      try {
        const parsed = JSON.parse(recordedRow.raw_json) as { status?: unknown };
        recorded_status = typeof parsed.status === "string" ? parsed.status : null;
      } catch {
        recorded_status = null;
      }
    }
    if (!last || recorded_status === null) continue;
    findingsWritten += writeFindings(
      db,
      now,
      assertDerivedStatus({
        uow_id: uow,
        recorded_status,
        derived_phase: last.state_to,
      }).map((f) => ({ ...f, uow_id: uow })),
    );
  }

  return {
    eventsIngested,
    transitionsIngested,
    uowsProjected: slotsByUow.size,
    findingsWritten,
  };
}
