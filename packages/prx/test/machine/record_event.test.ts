// GH-1616 — recordEvent() helper unit tests.

import { describe, expect, test } from "bun:test";

import type { AuditSinkDeps } from "../../src/audit/sink.ts";
import { recordEvent } from "../../src/machine/record_event.ts";

function captureSink(): { rows: unknown[]; deps: AuditSinkDeps } {
  const rows: unknown[] = [];
  const deps: AuditSinkDeps = {
    stateDirOverride: "/tmp/prx-test-record-event",
    appendFn: (_path: string, line: string) => {
      rows.push(JSON.parse(line));
    },
    ensureDir: () => {},
    env: {},
  };
  return { rows, deps };
}

describe("recordEvent", () => {
  test("throws on unknown event names", () => {
    expect(() => recordEvent("DEFINITELY_NOT_A_REAL_EVENT", { deps: captureSink().deps })).toThrow(
      /unknown catalog event/,
    );
  });

  test("looks up the owning actor from eventOwnerMap", () => {
    const { rows, deps } = captureSink();
    recordEvent("BD_READY_CACHE_HIT", { deps });
    recordEvent("NEXT_WORK_PROJECTED", { deps });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "catalog-event",
      event: "BD_READY_CACHE_HIT",
      actor: "beads",
    });
    expect(rows[1]).toMatchObject({
      kind: "catalog-event",
      event: "NEXT_WORK_PROJECTED",
      actor: "prx",
    });
  });

  test("TELEMETRY_SEAM_OBSERVED is a registered event (regression: was silently dropped)", () => {
    // The deterministic-seam telemetry must reach the audit sink, not throw
    // `unknown catalog event` and get swallowed by the best-effort sink wrapper.
    const { rows, deps } = captureSink();
    recordEvent("TELEMETRY_SEAM_OBSERVED", {
      workUnitId: "GH-1",
      details: { seam: "checks", phase: "done", elapsedMs: 12 },
      deps,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "catalog-event",
      event: "TELEMETRY_SEAM_OBSERVED",
      actor: "telemetry",
      workUnitId: "GH-1",
      details: { seam: "checks", phase: "done" },
    });
  });

  test("forwards optional workUnitId, repo, and details", () => {
    const { rows, deps } = captureSink();
    recordEvent("NEXT_WORK_THREAD_RANKED", {
      deps,
      workUnitId: "GH-1616",
      repo: "owner/repo",
      details: { kind: "ready_to_start", count: 3 },
    });
    expect(rows[0]).toMatchObject({
      kind: "catalog-event",
      event: "NEXT_WORK_THREAD_RANKED",
      actor: "prx",
      workUnitId: "GH-1616",
      repo: "owner/repo",
      details: { kind: "ready_to_start", count: 3 },
    });
  });

  test("uses injected `now` for the ts field", () => {
    const { rows, deps } = captureSink();
    const fixed = new Date("2026-05-13T12:34:56.000Z");
    recordEvent("BD_READY_CACHE_HIT", { deps, now: () => fixed });
    expect(rows[0]).toMatchObject({ ts: "2026-05-13T12:34:56.000Z" });
  });

  test("omits workUnitId/repo/details when not provided", () => {
    const { rows, deps } = captureSink();
    recordEvent("BD_READY_CACHE_HIT", { deps });
    const row = rows[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty("workUnitId");
    expect(row).not.toHaveProperty("repo");
    expect(row).not.toHaveProperty("details");
  });
});
