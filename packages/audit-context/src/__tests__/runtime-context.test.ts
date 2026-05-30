import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __resetAuditRuntimeContextForTesting,
  getAuditRuntimeContext,
  setAuditRuntimeContext,
  withGhTruthReason,
} from "@bounded-systems/audit-context";

// The context is process-global — other test files that exercise `runCli`
// stamp it before this file runs. Reset around every case.
beforeEach(() => __resetAuditRuntimeContextForTesting());
afterEach(() => __resetAuditRuntimeContextForTesting());

describe("audit runtime context", () => {
  test("starts with verb null and the claude-code actor default", () => {
    expect(getAuditRuntimeContext()).toEqual({
      verb: null,
      actor: "claude-code",
      ghTruthReason: null,
    });
  });

  test("setAuditRuntimeContext updates only the supplied fields", () => {
    setAuditRuntimeContext({ verb: "triage.status" });
    expect(getAuditRuntimeContext()).toEqual({
      verb: "triage.status",
      actor: "claude-code",
      ghTruthReason: null,
    });
    setAuditRuntimeContext({ actor: "test-harness" });
    expect(getAuditRuntimeContext()).toEqual({
      verb: "triage.status",
      actor: "test-harness",
      ghTruthReason: null,
    });
    setAuditRuntimeContext({ verb: null });
    expect(getAuditRuntimeContext()).toEqual({
      verb: null,
      actor: "test-harness",
      ghTruthReason: null,
    });
  });

  test("__resetAuditRuntimeContextForTesting restores process-start defaults", () => {
    setAuditRuntimeContext({ verb: "intake.search", actor: "x" });
    __resetAuditRuntimeContextForTesting();
    expect(getAuditRuntimeContext()).toEqual({
      verb: null,
      actor: "claude-code",
      ghTruthReason: null,
    });
  });

  // GH-1602: `withGhTruthReason` lets a residual gh call in `runStatusActor`
  // tag itself as load-bearing (drift / stale / forward-orphan comparator).
  // The wrapper is scope-local — it must always restore the prior value, even
  // when the inner body throws or when callers nest.
  test("withGhTruthReason sets the reason for the duration of the body", () => {
    expect(getAuditRuntimeContext().ghTruthReason).toBeNull();
    const inner = withGhTruthReason("drift-comparator", () => {
      return getAuditRuntimeContext().ghTruthReason;
    });
    expect(inner).toBe("drift-comparator");
    expect(getAuditRuntimeContext().ghTruthReason).toBeNull();
  });

  test("withGhTruthReason restores the prior value when the body throws", () => {
    expect(() =>
      withGhTruthReason("stale-comparator", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(getAuditRuntimeContext().ghTruthReason).toBeNull();
  });

  test("withGhTruthReason nests — the inner reason wins for its scope", () => {
    const observed: Array<string | null> = [];
    withGhTruthReason("drift-comparator", () => {
      observed.push(getAuditRuntimeContext().ghTruthReason);
      withGhTruthReason("stale-comparator", () => {
        observed.push(getAuditRuntimeContext().ghTruthReason);
      });
      observed.push(getAuditRuntimeContext().ghTruthReason);
    });
    expect(observed).toEqual(["drift-comparator", "stale-comparator", "drift-comparator"]);
    expect(getAuditRuntimeContext().ghTruthReason).toBeNull();
  });
});
