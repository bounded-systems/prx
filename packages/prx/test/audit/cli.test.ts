// GH-1823 — CLI handler tests. Drive each subverb against a seeded
// in-memory DB and assert text + JSON output shape.

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AuditUowProjection,
  projectAuditSystem,
  projectAuditUow,
  runAuditIngest,
  runAuditSystem,
  runAuditUow,
} from "../../src/audit/cli.ts";
import { openAuditDb } from "../../src/audit/store/db.ts";
import { ingestAuditSources } from "../../src/audit/store/ingest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(here, "fixtures");

function setupFixtures(): { auditDir: string; transitionDir: string } {
  const root = mkdtempSync(join(tmpdir(), "audit-cli-test-"));
  const auditDir = join(root, "audit");
  const transitionDir = join(root, "transitions");
  mkdirSync(auditDir);
  mkdirSync(transitionDir);
  writeFileSync(
    join(auditDir, "2026-05-16.ndjson"),
    readFileSync(resolve(FIXTURE_DIR, "events.fixture.ndjson"), "utf8"),
  );
  writeFileSync(
    join(transitionDir, "GH-1823.jsonl"),
    readFileSync(resolve(FIXTURE_DIR, "transitions.fixture.jsonl"), "utf8"),
  );
  return { auditDir, transitionDir };
}

type Captured = { stdout: string[]; stderr: string[] };
function makeOutput(): { output: { log: (s: string) => void; error: (s: string) => void }; captured: Captured } {
  const captured: Captured = { stdout: [], stderr: [] };
  return {
    output: {
      log: (s: string) => captured.stdout.push(s),
      error: (s: string) => captured.stderr.push(s),
    },
    captured,
  };
}

describe("runAuditIngest", () => {
  it("emits a plain summary by default", () => {
    const { auditDir, transitionDir } = setupFixtures();
    const db = openAuditDb({ dbPath: ":memory:" });
    const { output, captured } = makeOutput();
    runAuditIngest({}, output, { db, auditDir, transitionDir });
    expect(captured.stdout).toHaveLength(1);
    expect(captured.stdout[0]).toMatch(/^ingested events=9 transitions=3 uows=2 findings=/);
    db.close();
  });

  it("emits JSON when --format=json", () => {
    const { auditDir, transitionDir } = setupFixtures();
    const db = openAuditDb({ dbPath: ":memory:" });
    const { output, captured } = makeOutput();
    runAuditIngest({ format: "json" }, output, { db, auditDir, transitionDir });
    const parsed = JSON.parse(captured.stdout[0]!);
    expect(parsed).toMatchObject({
      eventsIngested: 9,
      transitionsIngested: 3,
      uowsProjected: 2,
    });
    expect(typeof parsed.findingsWritten).toBe("number");
    db.close();
  });
});

describe("runAuditUow / projectAuditUow", () => {
  it("projects the artifact chain and findings for a seeded UoW", () => {
    const { auditDir, transitionDir } = setupFixtures();
    const db = openAuditDb({ dbPath: ":memory:" });
    ingestAuditSources(db, { auditDir, transitionDir });
    const projection = projectAuditUow(db, "GH-1823");
    expect(projection.uow_id).toBe("GH-1823");
    expect(projection.events_with_uow_id.numerator).toBeGreaterThan(0);
    expect(projection.artifact_chain.length).toBeGreaterThan(0);
    // For GH-1823 the fixture lands patch_proposal, patch_check, guard_check,
    // test_run. work_map / delegation_record / plan / review_bundle remain
    // absent in the V1 baseline.
    const byType = Object.fromEntries(
      projection.artifact_chain.map((c) => [c.type, c.status]),
    );
    expect(byType.patch_proposal).toBe("present");
    expect(byType.test_run).toBe("present");
    expect(byType.review_bundle).toBe("absent");
    db.close();
  });

  it("emits next_valid_action when a required slot is absent", () => {
    const { auditDir, transitionDir } = setupFixtures();
    const db = openAuditDb({ dbPath: ":memory:" });
    ingestAuditSources(db, { auditDir, transitionDir });
    const projection = projectAuditUow(db, "GH-1808");
    // GH-1808 has only patch_proposal and was promoted to in_review — the
    // projector should suggest creating the next missing required artifact.
    expect(projection.next_valid_action).toContain("GH-1808");
    db.close();
  });

  it("emits JSON when --format=json", () => {
    const { auditDir, transitionDir } = setupFixtures();
    const db = openAuditDb({ dbPath: ":memory:" });
    ingestAuditSources(db, { auditDir, transitionDir });
    const { output, captured } = makeOutput();
    runAuditUow({ workUnitId: "GH-1823", format: "json" }, output, { db });
    const parsed = JSON.parse(captured.stdout[0]!) as AuditUowProjection;
    expect(parsed.uow_id).toBe("GH-1823");
    expect(Array.isArray(parsed.artifact_chain)).toBe(true);
    db.close();
  });

  it("text output starts with `UoW: <id>`", () => {
    const { auditDir, transitionDir } = setupFixtures();
    const db = openAuditDb({ dbPath: ":memory:" });
    ingestAuditSources(db, { auditDir, transitionDir });
    const { output, captured } = makeOutput();
    runAuditUow({ workUnitId: "GH-1823", format: "plain" }, output, { db });
    expect(captured.stdout[0]).toBe("UoW: GH-1823");
    expect(captured.stdout.some((l) => l.includes("artifact chain:"))).toBe(true);
    expect(captured.stdout.some((l) => l.includes("current derived phase:"))).toBe(true);
    db.close();
  });
});

describe("runAuditSystem / projectAuditSystem", () => {
  it("returns all seven metric rows", () => {
    const { auditDir, transitionDir } = setupFixtures();
    const db = openAuditDb({ dbPath: ":memory:" });
    ingestAuditSources(db, { auditDir, transitionDir });
    const rows = projectAuditSystem(db);
    expect(rows.map((r) => r.metric)).toEqual([
      "uow_attachment_rate",
      "artifact_coverage_rate",
      "lineage_completeness_rate",
      "guarded_transition_rate",
      "ambient_git_violations",
      "patch_evidence_rate",
      "derivable_status_rate",
    ]);
    db.close();
  });

  it("JSON output wraps metrics in { since, metrics }", () => {
    const { auditDir, transitionDir } = setupFixtures();
    const db = openAuditDb({ dbPath: ":memory:" });
    ingestAuditSources(db, { auditDir, transitionDir });
    const { output, captured } = makeOutput();
    runAuditSystem({ since: "7d", format: "json" }, output, { db });
    const parsed = JSON.parse(captured.stdout[0]!);
    expect(parsed.since).toBe("7d");
    expect(parsed.metrics).toHaveLength(7);
    db.close();
  });
});
