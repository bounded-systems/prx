// GH-1311 — resolvePlanSessionUnit tests.
//
// Verifies the four-step resolution order (flag > session env > detected >
// missing) used by the plan toolset verbs (save / load / show / view) when
// `--unit` is omitted. Detector is injected per the project's DI-by-convention
// test-isolation pattern (no env mutation, no real git/process probing).

import { describe, expect, test } from "bun:test";

import {
  resolvePlanSessionUnit,
  type PlanUnitDetector,
} from "../../src/plan-store/session-context.ts";

const stubDetector =
  (workUnitId: string, launchFromCurrentWorkspace = false): PlanUnitDetector =>
  () => ({ workUnitId, launchFromCurrentWorkspace });

describe("resolvePlanSessionUnit (GH-1311)", () => {
  test("explicit --unit beats env and detection", () => {
    const result = resolvePlanSessionUnit("GH-9001", {
      env: { PRX_PLAN_SESSION_UNIT: "GH-7777" },
      detect: stubDetector("GH-1234"),
    });
    expect(result).toEqual({ unit: "GH-9001", source: "flag" });
  });

  test("trims surrounding whitespace on flag value", () => {
    const result = resolvePlanSessionUnit("  GH-9001  ", { env: {} });
    expect(result).toEqual({ unit: "GH-9001", source: "flag" });
  });

  test("PRX_PLAN_SESSION_UNIT env wins when --unit is missing", () => {
    const result = resolvePlanSessionUnit(undefined, {
      env: { PRX_PLAN_SESSION_UNIT: "GH-7777" },
      detect: stubDetector("GH-1234"),
    });
    expect(result).toEqual({ unit: "GH-7777", source: "session" });
  });

  test("ignores empty / whitespace-only env value", () => {
    const result = resolvePlanSessionUnit(undefined, {
      env: { PRX_PLAN_SESSION_UNIT: "   " },
      detect: stubDetector("GH-1234"),
    });
    expect(result).toEqual({ unit: "GH-1234", source: "detected" });
  });

  test("falls through to cwd/branch detection when flag and env are missing", () => {
    const result = resolvePlanSessionUnit(undefined, {
      env: {},
      detect: stubDetector("GH-1234"),
    });
    expect(result).toEqual({ unit: "GH-1234", source: "detected" });
  });

  test("returns missing when nothing resolves and no detector is supplied", () => {
    const result = resolvePlanSessionUnit(undefined, { env: {} });
    expect(result).toEqual({ unit: null, source: "missing" });
  });

  test("treats empty-string flag the same as omitted", () => {
    const result = resolvePlanSessionUnit("", {
      env: { PRX_PLAN_SESSION_UNIT: "GH-7777" },
    });
    expect(result).toEqual({ unit: "GH-7777", source: "session" });
  });

  test("launchFromCurrentWorkspace=true falls through to missing", () => {
    // Copilot review on PR #1344: the detector's basename/branch fallback
    // (e.g. "main" on the mainx worktree) flips launchFromCurrentWorkspace
    // to true. The resolver must NOT treat that as a valid unit, otherwise
    // `prx plan load` / `show` / `save` silently target bogus refs like
    // "main". Operators must set PRX_PLAN_SESSION_UNIT, pass --unit, or
    // run from a canonical worktree.
    const result = resolvePlanSessionUnit(undefined, {
      env: {},
      detect: stubDetector("main", true),
    });
    expect(result).toEqual({ unit: null, source: "missing" });
  });

  test("canonical detected value (launchFromCurrentWorkspace=false) returns as 'detected'", () => {
    const result = resolvePlanSessionUnit(undefined, {
      env: {},
      detect: stubDetector("GH-1311", false),
    });
    expect(result).toEqual({ unit: "GH-1311", source: "detected" });
  });
});
