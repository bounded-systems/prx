// GH-1600 — direct unit tests for `getWatermark`.
//
// Pins the contract that every bd "absent" representation maps to
// `{ since: null }`. bd has two version-dependent absent modes:
//   - exit 0 with stdout "<key> (not set)\n" (current bd, GH-1600 regression)
//   - non-zero exit with stderr "config key not set" (legacy bd)
// Both must be coerced. Genuine spawn failures still throw.

import { describe, expect, test } from "bun:test";

import {
  getLastPoints,
  getWatermark,
  LAST_POINTS_KEY,
  WatermarkError,
  WATERMARK_KEY,
  type SpawnResult,
  type SpawnRunner,
} from "../../src/fetch/watermark.ts";

function runnerReturning(result: SpawnResult): SpawnRunner {
  return () => result;
}

describe("getWatermark", () => {
  test("returns the trimmed timestamp when bd emits a value", () => {
    const runner = runnerReturning({
      stdout: "2026-05-12T00:00:00Z\n",
      stderr: "",
      status: 0,
    });
    expect(getWatermark({ cwd: "/tmp", runner })).toEqual({
      since: "2026-05-12T00:00:00Z",
    });
  });

  test("returns { since: null } when bd exits 0 with empty stdout", () => {
    const runner = runnerReturning({ stdout: "", stderr: "", status: 0 });
    expect(getWatermark({ cwd: "/tmp", runner })).toEqual({ since: null });
  });

  test("returns { since: null } for legacy bd stderr/exit-1 absent mode", () => {
    const runner = runnerReturning({
      stdout: "",
      stderr: "config key not set",
      status: 1,
    });
    expect(getWatermark({ cwd: "/tmp", runner })).toEqual({ since: null });
  });

  test("returns { since: null } for current bd stdout/exit-0 sentinel (GH-1600)", () => {
    const runner = runnerReturning({
      stdout: `${WATERMARK_KEY} (not set)\n`,
      stderr: "",
      status: 0,
    });
    expect(getWatermark({ cwd: "/tmp", runner })).toEqual({ since: null });
  });

  test("throws WatermarkError on genuine spawn failure", () => {
    // Use a stderr message that doesn't match the absent-mode coercion
    // ("not set"/"not found") so we exercise the throw branch.
    const runner = runnerReturning({
      stdout: "",
      stderr: "permission denied opening config database",
      status: 1,
    });
    expect(() => getWatermark({ cwd: "/tmp", runner })).toThrow(WatermarkError);
    try {
      getWatermark({ cwd: "/tmp", runner });
    } catch (err) {
      expect(err).toBeInstanceOf(WatermarkError);
      expect((err as WatermarkError).code).toBe("WATERMARK_READ_FAILED");
    }
  });
});

describe("getLastPoints (GH-1257)", () => {
  test("parses an integer stdout into { points: n }", () => {
    const runner = runnerReturning({ stdout: "42\n", stderr: "", status: 0 });
    expect(getLastPoints({ cwd: "/tmp", runner })).toEqual({ points: 42 });
  });

  test("returns { points: null } for the exit-0 (not set) sentinel", () => {
    const runner = runnerReturning({
      stdout: `${LAST_POINTS_KEY} (not set)\n`,
      stderr: "",
      status: 0,
    });
    expect(getLastPoints({ cwd: "/tmp", runner })).toEqual({ points: null });
  });

  test("returns { points: null } for legacy bd stderr/exit-1 absent mode", () => {
    const runner = runnerReturning({
      stdout: "",
      stderr: "config key not set",
      status: 1,
    });
    expect(getLastPoints({ cwd: "/tmp", runner })).toEqual({ points: null });
  });

  test("returns { points: null } when stdout isn't a parseable integer", () => {
    const runner = runnerReturning({ stdout: "abc\n", stderr: "", status: 0 });
    expect(getLastPoints({ cwd: "/tmp", runner })).toEqual({ points: null });
  });

  test("returns { points: null } for negative integers", () => {
    const runner = runnerReturning({ stdout: "-3\n", stderr: "", status: 0 });
    expect(getLastPoints({ cwd: "/tmp", runner })).toEqual({ points: null });
  });

  test("returns { points: null } when stdout is empty on exit 0", () => {
    const runner = runnerReturning({ stdout: "", stderr: "", status: 0 });
    expect(getLastPoints({ cwd: "/tmp", runner })).toEqual({ points: null });
  });

  test("throws WatermarkError on genuine spawn failure", () => {
    const runner = runnerReturning({
      stdout: "",
      stderr: "permission denied opening config database",
      status: 1,
    });
    expect(() => getLastPoints({ cwd: "/tmp", runner })).toThrow(WatermarkError);
    try {
      getLastPoints({ cwd: "/tmp", runner });
    } catch (err) {
      expect(err).toBeInstanceOf(WatermarkError);
      expect((err as WatermarkError).code).toBe("LAST_POINTS_READ_FAILED");
    }
  });
});
