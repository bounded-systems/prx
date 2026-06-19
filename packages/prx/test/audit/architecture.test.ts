// GH-1823 — architectural acceptance tests.
//
// These tests translate the five negative cases from the GH-1823 issue body
// into runnable assertions. Each test seeds a small NDJSON / JSONL fixture,
// runs the ingester, and asserts the ingester behaved correctly:
//
//   1. PatchProposal event without uow_id → I-AUD1 finding fires.
//   2. TestRun without input_refs[]      → I-AUD2 finding fires; the slot
//      is marked status=present but the finding flags lineage.
//   3. UoW promoted to in_review without TestRun slot → I-AUD3 finding +
//      `prx audit uow <id>` projection's next_valid_action points at the
//      missing slot.
//   4. Agent emits `git push` event       → counted in I-AUD4 /
//      v_ambient_git_violations.
//   5. status_update event without UoW    → counted as unattached
//      (I-AUD1 / v_uow_attachment_rate).

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectAuditUow } from "../../src/audit/cli.ts";
import { openAuditDb } from "../../src/audit/store/db.ts";
import { ingestAuditSources } from "../../src/audit/store/ingest.ts";

type NdjsonRow = Record<string, unknown>;

function seedFixtures(rows: { audit: NdjsonRow[]; transitions: NdjsonRow[] }): {
  auditDir: string;
  transitionDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "audit-arch-test-"));
  const auditDir = join(root, "audit");
  const transitionDir = join(root, "transitions");
  mkdirSync(auditDir);
  mkdirSync(transitionDir);
  writeFileSync(
    join(auditDir, "2026-05-16.ndjson"),
    rows.audit.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  writeFileSync(
    join(transitionDir, "GH-1823.jsonl"),
    rows.transitions.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return { auditDir, transitionDir };
}

describe("architectural acceptance — I-AUD1..I-AUD5", () => {
  it("Case 1: PatchProposal event without uow_id → I-AUD1 finding", () => {
    const { auditDir, transitionDir } = seedFixtures({
      audit: [
        {
          ts: "2026-05-16T10:00:00.000Z",
          actor: "executor_agent",
          action: "artifact emit",
          artifact_type: "patch_proposal",
          artifact_ref: "scout://sha256:orphan",
          // no issue / no uow_id → unattached.
        },
      ],
      transitions: [],
    });
    const db = openAuditDb({ dbPath: ":memory:" });
    ingestAuditSources(db, { auditDir, transitionDir });
    const findings = db
      .query<{ invariant_id: string }, []>(
        `SELECT invariant_id FROM invariant_findings WHERE invariant_id = 'I-AUD1'`,
      )
      .all();
    expect(findings.length).toBeGreaterThan(0);
    db.close();
  });

  it("Case 2: TestRun without input_refs → I-AUD2 finding", () => {
    const { auditDir, transitionDir } = seedFixtures({
      audit: [
        {
          ts: "2026-05-16T10:00:00.000Z",
          actor: "tester_agent",
          action: "artifact emit",
          issue: "GH-1823",
          artifact_type: "test_run",
          artifact_ref: "scout://sha256:test",
          // input_refs missing — lineage violation.
        },
      ],
      transitions: [],
    });
    const db = openAuditDb({ dbPath: ":memory:" });
    ingestAuditSources(db, { auditDir, transitionDir });
    const findings = db
      .query<{ invariant_id: string }, []>(
        `SELECT invariant_id FROM invariant_findings WHERE invariant_id = 'I-AUD2'`,
      )
      .all();
    expect(findings.length).toBeGreaterThan(0);
    db.close();
  });

  it("Case 3: UoW promoted to in_review without TestRun → I-AUD3 + next_valid_action", () => {
    const { auditDir, transitionDir } = seedFixtures({
      audit: [
        {
          ts: "2026-05-16T10:00:00.000Z",
          actor: "executor_agent",
          action: "artifact emit",
          issue: "GH-1823",
          artifact_type: "patch_proposal",
          artifact_ref: "scout://sha256:patch",
          input_refs: ["scout://sha256:plan"],
        },
      ],
      transitions: [
        {
          id: "tx-1",
          issue: "GH-1823",
          state_from: "pushed",
          state_to: "in_review",
          actor: "prx",
          artifact: null,
          timestamp: "2026-05-16T10:01:00.000Z",
        },
      ],
    });
    const db = openAuditDb({ dbPath: ":memory:" });
    ingestAuditSources(db, { auditDir, transitionDir });
    const i_aud3 = db
      .query<{ invariant_id: string; uow_id: string | null }, []>(
        `SELECT invariant_id, uow_id FROM invariant_findings WHERE invariant_id = 'I-AUD3'`,
      )
      .all();
    expect(i_aud3.some((f) => f.uow_id === "GH-1823")).toBe(true);

    const projection = projectAuditUow(db, "GH-1823");
    expect(projection.next_valid_action).not.toBeNull();
    expect(projection.next_valid_action!).toMatch(/test_run|patch_check|guard_check|review_bundle/);
    db.close();
  });

  it("Case 4: Agent emits `git push` → counted in v_ambient_git_violations", () => {
    const { auditDir, transitionDir } = seedFixtures({
      audit: [
        {
          ts: "2026-05-16T10:00:00.000Z",
          actor: "claude-code",
          action: "git push",
          issue: "GH-1823",
        },
      ],
      transitions: [],
    });
    const db = openAuditDb({ dbPath: ":memory:" });
    ingestAuditSources(db, { auditDir, transitionDir });
    const m = db
      .query<{ numerator: number; met: number }, []>(
        "SELECT numerator, met FROM v_ambient_git_violations",
      )
      .get();
    expect(m!.numerator).toBe(1);
    expect(m!.met).toBe(0);
    db.close();
  });

  it("Case 5: StatusUpdate event without UoW → counted as unattached", () => {
    const { auditDir, transitionDir } = seedFixtures({
      audit: [
        {
          ts: "2026-05-16T10:00:00.000Z",
          actor: "executor_agent",
          action: "artifact emit",
          artifact_type: "status_update",
          // no issue / uow_id.
        },
      ],
      transitions: [],
    });
    const db = openAuditDb({ dbPath: ":memory:" });
    ingestAuditSources(db, { auditDir, transitionDir });
    const m = db
      .query<{ numerator: number; denominator: number; rate: number }, []>(
        "SELECT numerator, denominator, rate FROM v_uow_attachment_rate",
      )
      .get();
    expect(m!.denominator).toBe(1);
    expect(m!.numerator).toBe(0);
    expect(m!.rate).toBeCloseTo(0, 5);
    db.close();
  });
});
