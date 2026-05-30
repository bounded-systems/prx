// GH-1823 — store-level tests: schema, ingester idempotence, view outputs.
//
// Each test opens an in-memory DB (so concurrent test files don't fight over
// the on-disk metrics.sqlite), points the ingester at the checked-in
// NDJSON / JSONL fixtures, then asserts (numerator, denominator, rate, met)
// tuples per metric view.

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openAuditDb } from "../../src/audit/store/db.ts";
import { ingestAuditSources } from "../../src/audit/store/ingest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(here, "fixtures");

function setupFixtureDirs(): { auditDir: string; transitionDir: string } {
  const root = mkdtempSync(join(tmpdir(), "audit-store-test-"));
  const auditDir = join(root, "audit");
  const transitionDir = join(root, "transitions");
  mkdirSync(auditDir);
  mkdirSync(transitionDir);
  // Copy fixtures into the expected dir layout.
  const events = readFixture("events.fixture.ndjson");
  writeFileSync(join(auditDir, "2026-05-16.ndjson"), events);
  const transitions = readFixture("transitions.fixture.jsonl");
  writeFileSync(join(transitionDir, "GH-1823.jsonl"), transitions);
  return { auditDir, transitionDir };
}

function readFixture(name: string): string {
  return require("node:fs").readFileSync(resolve(FIXTURE_DIR, name), "utf8");
}

type MetricRow = {
  metric: string;
  numerator: number;
  denominator: number;
  rate: number;
  target: number;
  met: number;
};

function selectMetric(db: ReturnType<typeof openAuditDb>, view: string): MetricRow {
  return db.query<MetricRow, []>(`SELECT * FROM ${view}`).get() as MetricRow;
}

describe("audit store ingester", () => {
  it("creates the schema (tables + views) on first open", () => {
    const db = openAuditDb({ dbPath: ":memory:" });
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toContain("events");
    expect(tables).toContain("transitions");
    expect(tables).toContain("uow_artifacts");
    expect(tables).toContain("invariant_findings");

    const views = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(views).toEqual([
      "v_ambient_git_violations",
      "v_artifact_coverage_rate",
      "v_derivable_status_rate",
      "v_guarded_transition_rate",
      "v_lineage_completeness_rate",
      "v_patch_evidence_rate",
      "v_uow_attachment_rate",
    ]);
    db.close();
  });

  it("ingests fixtures and populates events / transitions / uow_artifacts", () => {
    const { auditDir, transitionDir } = setupFixtureDirs();
    const db = openAuditDb({ dbPath: ":memory:" });
    const result = ingestAuditSources(db, { auditDir, transitionDir });
    expect(result.eventsIngested).toBe(9);
    expect(result.transitionsIngested).toBe(3);
    expect(result.uowsProjected).toBe(2);

    const slots = db
      .query<{ uow_id: string; artifact_type: string; status: string }, []>(
        "SELECT uow_id, artifact_type, status FROM uow_artifacts ORDER BY uow_id, artifact_type",
      )
      .all();
    // GH-1823 has four typed artifacts; GH-1808 has one.
    expect(slots).toEqual([
      { uow_id: "GH-1808", artifact_type: "patch_proposal", status: "present" },
      { uow_id: "GH-1823", artifact_type: "guard_check", status: "present" },
      { uow_id: "GH-1823", artifact_type: "patch_check", status: "present" },
      { uow_id: "GH-1823", artifact_type: "patch_proposal", status: "present" },
      { uow_id: "GH-1823", artifact_type: "test_run", status: "present" },
    ]);
    db.close();
  });

  it("is idempotent — second ingest is a no-op for events and transitions", () => {
    const { auditDir, transitionDir } = setupFixtureDirs();
    const db = openAuditDb({ dbPath: ":memory:" });
    ingestAuditSources(db, { auditDir, transitionDir });
    const second = ingestAuditSources(db, { auditDir, transitionDir });
    expect(second.eventsIngested).toBe(0);
    expect(second.transitionsIngested).toBe(0);
    db.close();
  });

  it("counts ambient-git violations under I-AUD4 / v_ambient_git_violations", () => {
    const { auditDir, transitionDir } = setupFixtureDirs();
    const db = openAuditDb({ dbPath: ":memory:" });
    ingestAuditSources(db, { auditDir, transitionDir });
    const m = selectMetric(db, "v_ambient_git_violations");
    expect(m.numerator).toBe(1);
    expect(m.target).toBe(0);
    expect(m.met).toBe(0);
    db.close();
  });

  it("counts uow attachment correctly (2 unattached / 9 total → 7/9)", () => {
    const { auditDir, transitionDir } = setupFixtureDirs();
    const db = openAuditDb({ dbPath: ":memory:" });
    ingestAuditSources(db, { auditDir, transitionDir });
    const m = selectMetric(db, "v_uow_attachment_rate");
    expect(m.denominator).toBe(9);
    expect(m.numerator).toBe(7);
    expect(m.met).toBe(0); // 7/9 ≈ 0.78 < 0.95
    db.close();
  });

  it("flags GH-1808 transition as unguarded under I-AUD3", () => {
    const { auditDir, transitionDir } = setupFixtureDirs();
    const db = openAuditDb({ dbPath: ":memory:" });
    ingestAuditSources(db, { auditDir, transitionDir });
    const i_aud3 = db
      .query<{ uow_id: string | null; invariant_id: string }, []>(
        "SELECT uow_id, invariant_id FROM invariant_findings WHERE invariant_id = 'I-AUD3'",
      )
      .all();
    // GH-1823 satisfies the in_review guard (patch_proposal+patch_check+
    // guard_check+test_run present); GH-1808 does not. We expect at least
    // one I-AUD3 finding for GH-1808.
    expect(i_aud3.some((f) => f.uow_id === "GH-1808")).toBe(true);
    db.close();
  });
});
