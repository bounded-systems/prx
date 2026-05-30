-- GH-1823 — metrics store DDL for the `prx audit` verb.
--
-- Backed by `bun:sqlite`; lives at `~/.local/state/prx/audit/metrics.sqlite`.
-- The four tables capture, per-UoW, the four primary signals the seven V1
-- metrics roll up:
--
--   events             — raw audit-row stream, keyed by event_id (idempotent
--                        re-ingest is the watermark contract).
--   transitions        — phase-transition log entries (state_from→state_to)
--                        with the artifact that drove the transition.
--   uow_artifacts      — projected slot table: one row per (uow_id,
--                        artifact_type), updated by the ingester from
--                        events + transitions.
--   invariant_findings — per-UoW findings emitted by I-AUD1..I-AUD5.
--
-- Seven views translate (numerator, denominator, target, met) tuples
-- parameterised by a `since_ts` floor. Each view is intentionally simple
-- SQL — the metric DEFINITION lives here so reviewers can audit the
-- adherence math without reading TypeScript.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  event_id      TEXT PRIMARY KEY,
  ts            TEXT NOT NULL,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  uow_id        TEXT,
  artifact_type TEXT,
  artifact_ref  TEXT,
  raw_json      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_uow ON events(uow_id);

CREATE TABLE IF NOT EXISTS transitions (
  id              TEXT PRIMARY KEY,
  issue           TEXT,
  state_from      TEXT NOT NULL,
  state_to        TEXT NOT NULL,
  actor           TEXT NOT NULL,
  artifact        TEXT,
  ts              TEXT NOT NULL,
  proof_commit    TEXT,
  proof_checks_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_transitions_ts ON transitions(ts);
CREATE INDEX IF NOT EXISTS idx_transitions_issue ON transitions(issue);

CREATE TABLE IF NOT EXISTS uow_artifacts (
  uow_id         TEXT NOT NULL,
  artifact_type  TEXT NOT NULL,
  status         TEXT NOT NULL,
  ref            TEXT,
  input_refs_json TEXT NOT NULL DEFAULT '[]',
  last_seen_ts   TEXT,
  PRIMARY KEY (uow_id, artifact_type)
);

CREATE INDEX IF NOT EXISTS idx_uow_artifacts_status ON uow_artifacts(status);

CREATE TABLE IF NOT EXISTS invariant_findings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  uow_id       TEXT,
  invariant_id TEXT NOT NULL,
  status       TEXT NOT NULL,
  detail_json  TEXT NOT NULL DEFAULT '{}',
  ts           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invariant_findings_uow ON invariant_findings(uow_id);
CREATE INDEX IF NOT EXISTS idx_invariant_findings_ts ON invariant_findings(ts);

-- Ingestion watermark — last event_id and ts the ingester has consumed.
CREATE TABLE IF NOT EXISTS ingest_watermark (
  source       TEXT PRIMARY KEY,
  last_ts      TEXT NOT NULL,
  last_seen_id TEXT
);

-- ─── Metric views ─────────────────────────────────────────────────────────
-- Each view returns one row with columns:
--   metric, numerator, denominator, rate, target, met
-- Callers parameterise by `since_ts` via a CTE binding.
--
-- Views are dropped and recreated on every open so DDL changes flow into
-- pre-existing on-disk databases. Tables keep `CREATE TABLE IF NOT EXISTS`
-- semantics (data is preserved) — only the read-only projection layer is
-- versioned this aggressively.

DROP VIEW IF EXISTS v_uow_attachment_rate;
DROP VIEW IF EXISTS v_artifact_coverage_rate;
DROP VIEW IF EXISTS v_lineage_completeness_rate;
DROP VIEW IF EXISTS v_guarded_transition_rate;
DROP VIEW IF EXISTS v_ambient_git_violations;
DROP VIEW IF EXISTS v_patch_evidence_rate;
DROP VIEW IF EXISTS v_derivable_status_rate;

-- m1: uow_attachment_rate — fraction of events with a non-null uow_id.
CREATE VIEW IF NOT EXISTS v_uow_attachment_rate AS
SELECT
  'uow_attachment_rate' AS metric,
  SUM(CASE WHEN uow_id IS NOT NULL THEN 1 ELSE 0 END) AS numerator,
  COUNT(*) AS denominator,
  CASE WHEN COUNT(*) = 0 THEN 1.0
       ELSE 1.0 * SUM(CASE WHEN uow_id IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*)
  END AS rate,
  0.95 AS target,
  CASE WHEN COUNT(*) = 0 THEN 1
       WHEN 1.0 * SUM(CASE WHEN uow_id IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*) >= 0.95
       THEN 1 ELSE 0
  END AS met
FROM events;

-- m2: artifact_coverage_rate — fraction of `present-or-better` slots among
-- all slot rows (one per (uow_id, artifact_type) the ingester has touched).
CREATE VIEW IF NOT EXISTS v_artifact_coverage_rate AS
SELECT
  'artifact_coverage_rate' AS metric,
  COALESCE(SUM(CASE WHEN status IN ('present','passed') THEN 1 ELSE 0 END), 0) AS numerator,
  COUNT(*) AS denominator,
  CASE WHEN COUNT(*) = 0 THEN 1.0
       ELSE 1.0 * COALESCE(SUM(CASE WHEN status IN ('present','passed') THEN 1 ELSE 0 END), 0) / COUNT(*)
  END AS rate,
  0.90 AS target,
  CASE WHEN COUNT(*) = 0 THEN 1
       WHEN 1.0 * COALESCE(SUM(CASE WHEN status IN ('present','passed') THEN 1 ELSE 0 END), 0) / COUNT(*) >= 0.90
       THEN 1 ELSE 0
  END AS met
FROM uow_artifacts;

-- m3: lineage_completeness_rate — fraction of present/passed slots with a
-- non-empty input_refs[].
CREATE VIEW IF NOT EXISTS v_lineage_completeness_rate AS
SELECT
  'lineage_completeness_rate' AS metric,
  COALESCE(SUM(CASE WHEN status IN ('present','passed') AND input_refs_json <> '[]' THEN 1 ELSE 0 END), 0) AS numerator,
  COALESCE(SUM(CASE WHEN status IN ('present','passed') THEN 1 ELSE 0 END), 0) AS denominator,
  CASE WHEN COALESCE(SUM(CASE WHEN status IN ('present','passed') THEN 1 ELSE 0 END), 0) = 0 THEN 1.0
       ELSE 1.0 * COALESCE(SUM(CASE WHEN status IN ('present','passed') AND input_refs_json <> '[]' THEN 1 ELSE 0 END), 0)
              / COALESCE(SUM(CASE WHEN status IN ('present','passed') THEN 1 ELSE 0 END), 0)
  END AS rate,
  0.90 AS target,
  CASE WHEN COALESCE(SUM(CASE WHEN status IN ('present','passed') THEN 1 ELSE 0 END), 0) = 0 THEN 1
       WHEN 1.0 * COALESCE(SUM(CASE WHEN status IN ('present','passed') AND input_refs_json <> '[]' THEN 1 ELSE 0 END), 0)
              / COALESCE(SUM(CASE WHEN status IN ('present','passed') THEN 1 ELSE 0 END), 0) >= 0.90
       THEN 1 ELSE 0
  END AS met
FROM uow_artifacts;

-- m4: guarded_transition_rate — fraction of transitions whose
-- I-AUD3 predicate did not fire.
CREATE VIEW IF NOT EXISTS v_guarded_transition_rate AS
SELECT
  'guarded_transition_rate' AS metric,
  (SELECT COUNT(*) FROM transitions)
    - (SELECT COUNT(*) FROM invariant_findings WHERE invariant_id = 'I-AUD3')
    AS numerator,
  (SELECT COUNT(*) FROM transitions) AS denominator,
  CASE WHEN (SELECT COUNT(*) FROM transitions) = 0 THEN 1.0
       ELSE 1.0 * ((SELECT COUNT(*) FROM transitions)
                   - (SELECT COUNT(*) FROM invariant_findings WHERE invariant_id = 'I-AUD3'))
                / (SELECT COUNT(*) FROM transitions)
  END AS rate,
  0.95 AS target,
  CASE WHEN (SELECT COUNT(*) FROM transitions) = 0 THEN 1
       WHEN 1.0 * ((SELECT COUNT(*) FROM transitions)
                   - (SELECT COUNT(*) FROM invariant_findings WHERE invariant_id = 'I-AUD3'))
                / (SELECT COUNT(*) FROM transitions) >= 0.95
       THEN 1 ELSE 0
  END AS met;

-- m5: ambient_git_violations — absolute count of I-AUD4 findings. Target
-- is zero; `met` is 1 iff numerator is 0.
CREATE VIEW IF NOT EXISTS v_ambient_git_violations AS
SELECT
  'ambient_git_violations' AS metric,
  COUNT(*) AS numerator,
  COUNT(*) AS denominator,
  CAST(COUNT(*) AS REAL) AS rate,
  0.0 AS target,
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS met
FROM invariant_findings
WHERE invariant_id = 'I-AUD4';

-- m6: patch_evidence_rate — among UoWs that reached review-or-later, the
-- fraction whose chain (patch_proposal + patch_check + guard_check +
-- test_run + review_bundle) is fully present.
CREATE VIEW IF NOT EXISTS v_patch_evidence_rate AS
WITH review_uows AS (
  SELECT DISTINCT uow_id
  FROM uow_artifacts
  WHERE artifact_type = 'review_bundle'
     OR (artifact_type IN ('test_run','test_plan') AND status IN ('present','passed'))
),
full_chain AS (
  SELECT
    ru.uow_id,
    CASE
      WHEN EXISTS (SELECT 1 FROM uow_artifacts ua WHERE ua.uow_id = ru.uow_id AND ua.artifact_type = 'patch_proposal' AND ua.status IN ('present','passed'))
       AND EXISTS (SELECT 1 FROM uow_artifacts ua WHERE ua.uow_id = ru.uow_id AND ua.artifact_type = 'patch_check'    AND ua.status IN ('present','passed'))
       AND EXISTS (SELECT 1 FROM uow_artifacts ua WHERE ua.uow_id = ru.uow_id AND ua.artifact_type = 'guard_check'    AND ua.status IN ('present','passed'))
       AND EXISTS (SELECT 1 FROM uow_artifacts ua WHERE ua.uow_id = ru.uow_id AND ua.artifact_type = 'test_run'       AND ua.status IN ('present','passed'))
       AND EXISTS (SELECT 1 FROM uow_artifacts ua WHERE ua.uow_id = ru.uow_id AND ua.artifact_type = 'review_bundle'  AND ua.status IN ('present','passed'))
      THEN 1 ELSE 0
    END AS complete
  FROM review_uows ru
)
SELECT
  'patch_evidence_rate' AS metric,
  COALESCE(SUM(complete), 0) AS numerator,
  COUNT(*) AS denominator,
  CASE WHEN COUNT(*) = 0 THEN 1.0
       ELSE 1.0 * COALESCE(SUM(complete), 0) / COUNT(*)
  END AS rate,
  0.80 AS target,
  CASE WHEN COUNT(*) = 0 THEN 1
       WHEN 1.0 * COALESCE(SUM(complete), 0) / COUNT(*) >= 0.80
       THEN 1 ELSE 0
  END AS met
FROM full_chain;

-- m7: derivable_status_rate — fraction of UoWs without an I-AUD5 finding,
-- among UoWs the ingester has projected at least one artifact slot for.
CREATE VIEW IF NOT EXISTS v_derivable_status_rate AS
WITH active_uows AS (
  SELECT DISTINCT uow_id FROM uow_artifacts WHERE uow_id IS NOT NULL
),
diverged AS (
  SELECT DISTINCT uow_id FROM invariant_findings WHERE invariant_id = 'I-AUD5'
)
SELECT
  'derivable_status_rate' AS metric,
  ((SELECT COUNT(*) FROM active_uows) - (SELECT COUNT(*) FROM diverged)) AS numerator,
  (SELECT COUNT(*) FROM active_uows) AS denominator,
  CASE WHEN (SELECT COUNT(*) FROM active_uows) = 0 THEN 1.0
       ELSE 1.0 * ((SELECT COUNT(*) FROM active_uows) - (SELECT COUNT(*) FROM diverged))
              / (SELECT COUNT(*) FROM active_uows)
  END AS rate,
  0.90 AS target,
  CASE WHEN (SELECT COUNT(*) FROM active_uows) = 0 THEN 1
       WHEN 1.0 * ((SELECT COUNT(*) FROM active_uows) - (SELECT COUNT(*) FROM diverged))
              / (SELECT COUNT(*) FROM active_uows) >= 0.90
       THEN 1 ELSE 0
  END AS met;
