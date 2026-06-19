import { describe, expect, test } from "bun:test";

import {
  buildCloseNote,
  runTriageClose,
  triageCloseOptionsSchema,
} from "../../src/triage/close.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";

function bead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "ai-home-mgwqw",
    title: "junk reverse-orphan",
    description: "",
    status: "open",
    priority: 2,
    issueType: "task",
    externalRef: null,
    externalRefs: {},
    metadata: null,
    externalIssueNumber: null,
    sourceSystem: null,
    ...overrides,
  };
}

function makeOutput() {
  const log: string[] = [];
  const error: string[] = [];
  return {
    output: { log: (line: string) => log.push(line), error: (line: string) => error.push(line) },
    log,
    error,
  };
}

/**
 * Daemon-backed deps (GH-296 wave 2): `showBead` returns the targeted record
 * (or null), `closeBead` records its calls and optionally throws (the daemon
 * bd-write error). The bd-level dispatch (update --status closed --notes) is
 * covered by daemon.test.ts; here we assert the verb's behavior + what it asks
 * the daemon to do.
 */
function makeDeps(record: BeadsRecord | null, opts: { closeThrows?: string } = {}) {
  const closeCalls: Array<{ id: string; reason?: string }> = [];
  const invalidations: number[] = [];
  const deps = {
    showBead: async (_id: string): Promise<BeadsRecord | null> => record,
    closeBead: async (id: string, reason?: string): Promise<BeadsRecord | null> => {
      closeCalls.push({ id, ...(reason !== undefined ? { reason } : {}) });
      if (opts.closeThrows) throw new Error(opts.closeThrows);
      return null;
    },
    invalidateBeadsCache: () => invalidations.push(invalidations.length),
  };
  return { deps, closeCalls, invalidations };
}

describe("buildCloseNote", () => {
  test("emits reason prefix when no note is supplied", () => {
    expect(buildCloseNote("not-planned", undefined)).toBe(
      "closed via prx triage close (reason=not-planned)",
    );
  });

  test("appends note after the reason prefix", () => {
    expect(buildCloseNote("not-planned", "junk reverse-orphan")).toBe(
      "closed via prx triage close (reason=not-planned): junk reverse-orphan",
    );
  });
});

describe("triageCloseOptionsSchema", () => {
  test("defaults reason to not-planned", () => {
    const parsed = triageCloseOptionsSchema.parse({ bdId: "ai-home-1" });
    expect(parsed.reason).toBe("not-planned");
    expect(parsed.dryRun).toBe(false);
    expect(parsed.format).toBe("plain");
  });

  test("rejects unknown reasons", () => {
    expect(() =>
      triageCloseOptionsSchema.parse({ bdId: "ai-home-1", reason: "wontfix" }),
    ).toThrow();
  });

  test("accepts each canonical reason", () => {
    for (const reason of ["completed", "not-planned", "duplicate"] as const) {
      const parsed = triageCloseOptionsSchema.parse({ bdId: "ai-home-1", reason });
      expect(parsed.reason).toBe(reason);
    }
  });

  test("requires a non-empty bdId", () => {
    expect(() => triageCloseOptionsSchema.parse({ bdId: "" })).toThrow();
    expect(() => triageCloseOptionsSchema.parse({ bdId: "   " })).toThrow();
  });
});

describe("runTriageClose — refusals", () => {
  test("bead not found", async () => {
    const o = makeOutput();
    const { deps, closeCalls } = makeDeps(null);
    const result = await runTriageClose(
      { bdId: "missing", reason: "not-planned", dryRun: false, format: "plain" },
      o.output,
      deps,
    );
    expect(result.closed).toBe(false);
    expect(result.refusalReason).toContain("not found");
    expect(closeCalls).toHaveLength(0);
    expect(o.error[0]).toContain("not found");
  });

  test("bead with external_ref points at prx plan close", async () => {
    const o = makeOutput();
    const { deps, closeCalls } = makeDeps(
      bead({
        id: "ai-home-linked",
        externalRef: "https://github.com/bdelanghe/ai-home/issues/42",
      }),
    );
    const result = await runTriageClose(
      { bdId: "ai-home-linked", reason: "completed", dryRun: false, format: "plain" },
      o.output,
      deps,
    );
    expect(result.closed).toBe(false);
    expect(result.refusalReason).toContain("prx plan close");
    expect(result.refusalReason).toContain("GH-linked");
    expect(closeCalls).toHaveLength(0);
  });

  test("bead already closed", async () => {
    const o = makeOutput();
    const { deps, closeCalls } = makeDeps(bead({ id: "ai-home-done", status: "closed" }));
    const result = await runTriageClose(
      { bdId: "ai-home-done", reason: "not-planned", dryRun: false, format: "plain" },
      o.output,
      deps,
    );
    expect(result.closed).toBe(false);
    expect(result.refusalReason).toContain("already closed");
    expect(closeCalls).toHaveLength(0);
  });

  test("a daemon read failure surfaces as a refusal", async () => {
    const o = makeOutput();
    const deps = {
      showBead: async (): Promise<BeadsRecord | null> => {
        throw new Error("bd unreachable: ECONNREFUSED");
      },
    };
    const result = await runTriageClose(
      { bdId: "ai-home-mgwqw", reason: "not-planned", dryRun: false, format: "plain" },
      o.output,
      deps,
    );
    expect(result.closed).toBe(false);
    expect(result.refusalReason).toContain("ECONNREFUSED");
  });
});

describe("runTriageClose — dry-run", () => {
  test("no close call, returns dryRun=true", async () => {
    const o = makeOutput();
    const { deps, closeCalls, invalidations } = makeDeps(bead());
    const result = await runTriageClose(
      { bdId: "ai-home-mgwqw", reason: "not-planned", dryRun: true, format: "plain" },
      o.output,
      deps,
    );
    expect(result.dryRun).toBe(true);
    expect(result.closed).toBe(false);
    expect(result.refusalReason).toBeNull();
    expect(closeCalls).toHaveLength(0);
    expect(invalidations).toHaveLength(0);
    expect(o.log[0]).toContain("dry-run ai-home-mgwqw");
    expect(o.log[0]).toContain("reason=not-planned");
  });
});

describe("runTriageClose — happy path", () => {
  test("asks the daemon to close with the composed note body", async () => {
    const o = makeOutput();
    const { deps, closeCalls, invalidations } = makeDeps(bead());
    const result = await runTriageClose(
      { bdId: "ai-home-mgwqw", reason: "not-planned", dryRun: false, format: "plain" },
      o.output,
      deps,
    );
    expect(result.closed).toBe(true);
    expect(result.refusalReason).toBeNull();
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]).toEqual({
      id: "ai-home-mgwqw",
      reason: "closed via prx triage close (reason=not-planned)",
    });
    expect(invalidations).toHaveLength(1);
    expect(o.log[0]).toContain("closed ai-home-mgwqw");
  });

  test("--note is appended after the reason prefix", async () => {
    const o = makeOutput();
    const { deps, closeCalls } = makeDeps(bead());
    await runTriageClose(
      {
        bdId: "ai-home-mgwqw",
        reason: "not-planned",
        note: "junk reverse-orphan",
        dryRun: false,
        format: "plain",
      },
      o.output,
      deps,
    );
    expect(closeCalls[0]!.reason).toBe(
      "closed via prx triage close (reason=not-planned): junk reverse-orphan",
    );
  });

  test("surfaces a daemon close failure as refusalReason", async () => {
    const o = makeOutput();
    const { deps, invalidations } = makeDeps(bead(), {
      closeThrows: "beadsd close: bd-write: bd boom",
    });
    const result = await runTriageClose(
      { bdId: "ai-home-mgwqw", reason: "not-planned", dryRun: false, format: "plain" },
      o.output,
      deps,
    );
    expect(result.closed).toBe(false);
    expect(result.refusalReason).toContain("bd boom");
    expect(invalidations).toHaveLength(0);
    expect(o.error[0]).toContain("bd update failed");
  });

  test("each canonical reason flows into the close note payload", async () => {
    for (const reason of ["completed", "not-planned", "duplicate"] as const) {
      const o = makeOutput();
      const { deps, closeCalls } = makeDeps(bead());
      await runTriageClose(
        { bdId: "ai-home-mgwqw", reason, dryRun: false, format: "plain" },
        o.output,
        deps,
      );
      expect(closeCalls[0]!.reason).toBe(`closed via prx triage close (reason=${reason})`);
    }
  });
});
