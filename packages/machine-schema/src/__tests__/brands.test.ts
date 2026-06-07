// GH-2098 — the branded ID parse seams. Nominal typing only (permissive
// min(1) shape), so these cover the parse + nullable passthrough behavior and
// the empty-string rejection that the min(1) carrier enforces.

import { describe, expect, test } from "bun:test";

import {
  parseBranchName,
  parseBranchNameNullable,
  parseSha,
  parseShaNullable,
  parseWorkUnitId,
  parseWorkUnitIdNullable,
} from "@bounded-systems/machine-schema";

describe("branded id parse seams", () => {
  test("non-nullable parsers brand a non-empty string", () => {
    // Branded types are nominal; compare the underlying string value.
    expect(parseSha("abc123") as string).toBe("abc123");
    expect(parseBranchName("feat/x") as string).toBe("feat/x");
    expect(parseWorkUnitId("GH-1") as string).toBe("GH-1");
  });

  test("non-nullable parsers reject the empty string (min(1) carrier)", () => {
    expect(() => parseSha("")).toThrow();
    expect(() => parseBranchName("")).toThrow();
    expect(() => parseWorkUnitId("")).toThrow();
  });

  test("nullable parsers pass null through untouched", () => {
    expect(parseShaNullable(null)).toBeNull();
    expect(parseBranchNameNullable(null)).toBeNull();
    expect(parseWorkUnitIdNullable(null)).toBeNull();
  });

  test("nullable parsers brand a present value", () => {
    expect(parseShaNullable("deadbeef") as string).toBe("deadbeef");
    expect(parseBranchNameNullable("main") as string).toBe("main");
    expect(parseWorkUnitIdNullable("GH-2") as string).toBe("GH-2");
  });
});
