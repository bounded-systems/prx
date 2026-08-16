// GH-1828 — the cancellation draft sink. Persists a cancelled planner's partial
// stdout into <UoW>:plan@draft. runPlanSave is injected, so all three paths
// (empty input, successful save, swallowed failure) run without CAS IO.

import { describe, expect, test } from "bun:test";

import { makeWorkUnitDraftSink } from "../../src/claude/partial_capture.ts";

const okSave = (over: Record<string, unknown> = {}) =>
  (async (args: { unit: string }) => ({
    sha: "sha",
    ref: `${args.unit}:plan@draft`,
    body_sha: "b",
    envelope_sha: "e",
    validated_ok: true,
    diagnostics: [],
    ...over,
  })) as never;

describe("makeWorkUnitDraftSink", () => {
  test("returns null without saving when the partial stdout is blank", async () => {
    let called = false;
    const sink = makeWorkUnitDraftSink("GH-1", {
      runPlanSave: (async () => {
        called = true;
        return {} as never;
      }) as never,
    });
    expect(await sink("   \n  ")).toBeNull();
    expect(called).toBe(false);
  });

  test("saves the partial draft and returns its ref", async () => {
    const calls: unknown[] = [];
    const sink = makeWorkUnitDraftSink("GH-42", {
      runPlanSave: (async (args: unknown) => {
        calls.push(args);
        return { ref: "GH-42:plan@draft" } as never;
      }) as never,
    });
    expect(await sink("partial plan output")).toBe("GH-42:plan@draft");
    expect(calls[0]).toMatchObject({ unit: "GH-42", slot: "draft", skipValidate: true });
  });

  test("swallows a save failure and returns null (soft-fail on cancel)", async () => {
    const sink = makeWorkUnitDraftSink("GH-7", {
      runPlanSave: (async () => {
        throw new Error("CAS down");
      }) as never,
    });
    expect(await sink("some output")).toBeNull();
  });

  test("defaults to a full runPlanSave-shaped result when none is injected via the seam", async () => {
    const sink = makeWorkUnitDraftSink("GH-9", { runPlanSave: okSave() });
    expect(await sink("x")).toBe("GH-9:plan@draft");
  });
});
