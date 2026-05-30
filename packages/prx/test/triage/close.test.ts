import { describe, expect, test } from "bun:test";

import {
  buildCloseNote,
  runTriageClose,
  triageCloseOptionsSchema,
} from "../../src/triage/close.ts";
import type { BdExecResult } from "@bounded-systems/bd";
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

type BdCall = { subcommand: string; args: string[]; state?: string; role?: string };

function makeDeps(records: BeadsRecord[], bdResults: BdExecResult[] = []) {
  const calls: BdCall[] = [];
  const invalidations: number[] = [];
  let idx = 0;
  const execBd = (opts: {
    subcommand: string;
    args: string[];
    state?: string;
    role?: string;
  }): BdExecResult => {
    calls.push({
      subcommand: opts.subcommand,
      args: opts.args,
      ...(opts.state !== undefined ? { state: opts.state } : {}),
      ...(opts.role !== undefined ? { role: opts.role } : {}),
    });
    const result = bdResults[idx] ?? { exitCode: 0, stdout: "", stderr: "", policy: null };
    idx += 1;
    return result;
  };
  const deps = {
    execBd: execBd as never,
    loadAllBeads: () => records,
    invalidateBeadsCache: () => invalidations.push(invalidations.length),
  };
  return { deps, calls, invalidations };
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
  test("bead not found", () => {
    const o = makeOutput();
    const { deps, calls } = makeDeps([]);
    const result = runTriageClose(
      { bdId: "missing", reason: "not-planned", dryRun: false, format: "plain" },
      o.output,
      deps,
    );
    expect(result.closed).toBe(false);
    expect(result.refusalReason).toContain("not found");
    expect(calls).toHaveLength(0);
    expect(o.error[0]).toContain("not found");
  });

  test("bead with external_ref points at prx plan close", () => {
    const o = makeOutput();
    const { deps, calls } = makeDeps([
      bead({
        id: "ai-home-linked",
        externalRef: "https://github.com/bdelanghe/ai-home/issues/42",
      }),
    ]);
    const result = runTriageClose(
      { bdId: "ai-home-linked", reason: "completed", dryRun: false, format: "plain" },
      o.output,
      deps,
    );
    expect(result.closed).toBe(false);
    expect(result.refusalReason).toContain("prx plan close");
    expect(result.refusalReason).toContain("GH-linked");
    expect(calls).toHaveLength(0);
  });

  test("bead already closed", () => {
    const o = makeOutput();
    const { deps, calls } = makeDeps([
      bead({ id: "ai-home-done", status: "closed" }),
    ]);
    const result = runTriageClose(
      { bdId: "ai-home-done", reason: "not-planned", dryRun: false, format: "plain" },
      o.output,
      deps,
    );
    expect(result.closed).toBe(false);
    expect(result.refusalReason).toContain("already closed");
    expect(calls).toHaveLength(0);
  });
});

describe("runTriageClose — dry-run", () => {
  test("no bd call, returns dryRun=true", () => {
    const o = makeOutput();
    const { deps, calls, invalidations } = makeDeps([bead()]);
    const result = runTriageClose(
      { bdId: "ai-home-mgwqw", reason: "not-planned", dryRun: true, format: "plain" },
      o.output,
      deps,
    );
    expect(result.dryRun).toBe(true);
    expect(result.closed).toBe(false);
    expect(result.refusalReason).toBeNull();
    expect(calls).toHaveLength(0);
    expect(invalidations).toHaveLength(0);
    expect(o.log[0]).toContain("dry-run ai-home-mgwqw");
    expect(o.log[0]).toContain("reason=not-planned");
  });
});

describe("runTriageClose — happy path", () => {
  test("writes bd update -s closed --notes with planner role", () => {
    const o = makeOutput();
    const { deps, calls, invalidations } = makeDeps([bead()]);
    const result = runTriageClose(
      { bdId: "ai-home-mgwqw", reason: "not-planned", dryRun: false, format: "plain" },
      o.output,
      deps,
    );
    expect(result.closed).toBe(true);
    expect(result.refusalReason).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subcommand).toBe("update");
    expect(calls[0]!.args).toEqual([
      "ai-home-mgwqw",
      "-s",
      "closed",
      "--notes",
      "closed via prx triage close (reason=not-planned)",
    ]);
    // The hard-blocked `bd close` path stays untouched; the verb routes
    // through `bd update` which the planner policy row admits at every state.
    expect(calls[0]!.role).toBe("planner");
    expect(calls[0]!.state).toBe("planning");
    expect(invalidations).toHaveLength(1);
    expect(o.log[0]).toContain("closed ai-home-mgwqw");
  });

  test("--note is appended after the reason prefix", () => {
    const o = makeOutput();
    const { deps, calls } = makeDeps([bead()]);
    runTriageClose(
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
    expect(calls[0]!.args[4]).toBe(
      "closed via prx triage close (reason=not-planned): junk reverse-orphan",
    );
  });

  test("surfaces bd failure as refusalReason", () => {
    const o = makeOutput();
    const { deps, invalidations } = makeDeps(
      [bead()],
      [{ exitCode: 1, stdout: "", stderr: "bd boom", policy: null }],
    );
    const result = runTriageClose(
      { bdId: "ai-home-mgwqw", reason: "not-planned", dryRun: false, format: "plain" },
      o.output,
      deps,
    );
    expect(result.closed).toBe(false);
    expect(result.refusalReason).toContain("bd boom");
    expect(invalidations).toHaveLength(0);
    expect(o.error[0]).toContain("bd update failed");
  });

  test("each canonical reason flows into the bd notes payload", () => {
    for (const reason of ["completed", "not-planned", "duplicate"] as const) {
      const o = makeOutput();
      const { deps, calls } = makeDeps([bead()]);
      runTriageClose(
        { bdId: "ai-home-mgwqw", reason, dryRun: false, format: "plain" },
        o.output,
        deps,
      );
      expect(calls[0]!.args[4]).toBe(`closed via prx triage close (reason=${reason})`);
    }
  });
});
