import { describe, expect, test } from "bun:test";

import {
  assertGcCapability,
  GC_DELETE_CAPABILITY,
  type GcDriver,
  type GcMark,
  isDestructiveComponent,
  markFindings,
  sweepableFromMark,
} from "../../../src/machine/gc/capability.ts";
import {
  GC_DESTRUCTIVE_COMPONENTS,
  type GcFinding,
} from "../../../src/machine/gc/schema.ts";

describe("gc capability gate (GH-2326)", () => {
  test("isDestructiveComponent tracks GC_DESTRUCTIVE_COMPONENTS", () => {
    for (const c of GC_DESTRUCTIVE_COMPONENTS) {
      expect(isDestructiveComponent(c)).toBe(true);
    }
    expect(isDestructiveComponent("sync")).toBe(false);
    expect(isDestructiveComponent("hooks")).toBe(false);
  });

  test("dry-run on a destructive component is allowed without a token", () => {
    expect(assertGcCapability({ component: "cas", apply: false })).toEqual({
      outcome: "allowed",
    });
    expect(assertGcCapability({ component: "worktree", apply: false })).toEqual({
      outcome: "allowed",
    });
  });

  test("apply on a destructive component without a token is capability-required", () => {
    const verdict = assertGcCapability({ component: "cas", apply: true });
    expect(verdict).toEqual({
      outcome: "capability-required",
      components: ["cas"],
      required: GC_DELETE_CAPABILITY,
    });
  });

  test("apply on a destructive component with an invalid token is capability-required", () => {
    const verdict = assertGcCapability({
      component: "worktree",
      apply: true,
      capability: "not-the-token",
    });
    expect(verdict).toEqual({
      outcome: "capability-required",
      components: ["worktree"],
      required: GC_DELETE_CAPABILITY,
    });
  });

  test("apply on a destructive component with the delete token is allowed", () => {
    expect(
      assertGcCapability({
        component: "cas",
        apply: true,
        capability: GC_DELETE_CAPABILITY,
      }),
    ).toEqual({ outcome: "allowed" });
  });

  test("apply on a non-destructive component is allowed without a token", () => {
    expect(assertGcCapability({ component: "sync", apply: true })).toEqual({
      outcome: "allowed",
    });
  });

  test("run --all (no component) gates only the destructive components", () => {
    const verdict = assertGcCapability({ apply: true });
    expect(verdict.outcome).toBe("capability-required");
    if (verdict.outcome === "capability-required") {
      // Reports exactly the destructive set — non-destructive components are
      // never blocked, preserving per-component failure isolation.
      expect(verdict.components).toEqual([...GC_DESTRUCTIVE_COMPONENTS]);
      expect(verdict.required).toBe(GC_DELETE_CAPABILITY);
    }
  });

  test("run --all with the delete token is allowed", () => {
    expect(
      assertGcCapability({ apply: true, capability: GC_DELETE_CAPABILITY }),
    ).toEqual({ outcome: "allowed" });
  });

  test("run --all dry-run is allowed", () => {
    expect(assertGcCapability({ apply: false })).toEqual({ outcome: "allowed" });
  });
});

describe("gc mark→sweep contract (GH-2326)", () => {
  const finding = (ref: string): GcFinding => ({
    component: "cas",
    class: "orphan",
    ref,
  });

  test("markFindings snapshots the findings with an ISO timestamp", () => {
    const at = new Date("2026-05-27T12:00:00.000Z");
    const mark = markFindings("cas", [finding("a"), finding("b")], at);
    expect(mark.component).toBe("cas");
    expect(mark.findings).toEqual([finding("a"), finding("b")]);
    expect(mark.marked_at).toBe("2026-05-27T12:00:00.000Z");
  });

  test("sweepableFromMark acts only on findings present in the mark", () => {
    const mark = markFindings("cas", [finding("a"), finding("b")]);
    // "c" went live (left the reclaimable set) after the mark; it must be
    // dropped, never swept — closes the TOCTOU data-loss class (D4).
    const candidates = [finding("a"), finding("c")];
    expect(sweepableFromMark(mark, candidates)).toEqual([finding("a")]);
  });

  test("sweepableFromMark on a candidate absent from the mark reclaims nothing", () => {
    const mark = markFindings("cas", [finding("a")]);
    expect(sweepableFromMark(mark, [finding("z")])).toEqual([]);
  });

  test("a GcDriver sweep restricts itself to the marked set", async () => {
    // Reference driver: phase 2 sees one extra live item ("c") that was not in
    // the mark; the contract requires it never sweeps that item.
    const driver: GcDriver = {
      component: "cas",
      mark: async () => [finding("a"), finding("b")],
      sweep: async (mark: GcMark) => {
        const live = [finding("a"), finding("b"), finding("c")];
        return { reclaimed: sweepableFromMark(mark, live) };
      },
    };
    const marked = markFindings(driver.component, await driver.mark());
    const result = await driver.sweep(marked, {
      capability: GC_DELETE_CAPABILITY,
    });
    expect(result.reclaimed).toEqual([finding("a"), finding("b")]);
  });
});
