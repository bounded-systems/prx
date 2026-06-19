import { describe, expect, test } from "bun:test";

import { readUnitTelemetry } from "../../src/audit/observe.ts";

const DATE = new Date("2026-06-06T12:00:00Z");
const opts = (workUnitId: string, lines: string[], limit?: number) => ({
  workUnitId,
  date: DATE,
  stateDirOverride: "/tmp/prx-test-observe",
  readFn: () => lines.join("\n"),
  ...(limit !== undefined ? { limit } : {}),
});

const row = (o: Record<string, unknown>) => JSON.stringify(o);

describe("readUnitTelemetry", () => {
  test("returns only TELEMETRY_* rows for the requested unit, in order", () => {
    const lines = [
      row({
        ts: "t1",
        event: "TELEMETRY_SEAM_OBSERVED",
        workUnitId: "GH-1",
        details: { seam: "intake", phase: "start" },
      }),
      row({ ts: "t2", event: "BD_READY_CACHE_HIT", workUnitId: "GH-1" }), // not telemetry
      row({ ts: "t3", event: "TELEMETRY_LEG_OBSERVED", workUnitId: "GH-2" }), // other unit
      row({
        ts: "t4",
        event: "TELEMETRY_SEAM_OBSERVED",
        workUnitId: "GH-1",
        details: { seam: "intake", phase: "done", elapsedMs: 9 },
      }),
    ];
    const events = readUnitTelemetry(opts("GH-1", lines));
    expect(events.map((e) => [e.event, e.details?.["phase"]])).toEqual([
      ["TELEMETRY_SEAM_OBSERVED", "start"],
      ["TELEMETRY_SEAM_OBSERVED", "done"],
    ]);
    expect(events[0]!.ts).toBe("t1");
  });

  test("a missing audit file reads as empty (no telemetry yet), not an error", () => {
    const events = readUnitTelemetry({
      workUnitId: "GH-1",
      date: DATE,
      stateDirOverride: "/tmp/prx-test-observe",
      readFn: () => "",
    });
    expect(events).toEqual([]);
  });

  test("skips malformed/partial lines instead of throwing", () => {
    const lines = [
      row({ ts: "t1", event: "TELEMETRY_SEAM_OBSERVED", workUnitId: "GH-1" }),
      "{ this is not json",
      row({ ts: "t2", event: "TELEMETRY_LEG_OBSERVED", workUnitId: "GH-1" }),
    ];
    const events = readUnitTelemetry(opts("GH-1", lines));
    expect(events.map((e) => e.event)).toEqual([
      "TELEMETRY_SEAM_OBSERVED",
      "TELEMETRY_LEG_OBSERVED",
    ]);
  });

  test("limit keeps the most recent N events", () => {
    const lines = [1, 2, 3, 4].map((n) =>
      row({
        ts: `t${n}`,
        event: "TELEMETRY_LEG_OBSERVED",
        workUnitId: "GH-1",
        details: { turns: n },
      }),
    );
    const events = readUnitTelemetry(opts("GH-1", lines, 2));
    expect(events.map((e) => e.ts)).toEqual(["t3", "t4"]);
  });
});
