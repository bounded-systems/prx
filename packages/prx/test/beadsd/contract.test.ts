import { describe, expect, test } from "bun:test";

import {
  BEADS_REQUEST_KINDS,
  BeadsRequestSchema,
  BeadsResponseSchema,
} from "../../src/beadsd/contract.ts";

describe("beadsd wire contract — request envelope", () => {
  test("the read envelope is an enumerable allowlist", () => {
    expect(BEADS_REQUEST_KINDS).toEqual(["ready", "list", "show"]);
  });

  test("accepts ready, list (±status), and show", () => {
    expect(BeadsRequestSchema.safeParse({ kind: "ready" }).success).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "list" }).success).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "list", status: "open" }).success).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "show", id: "GH-228" }).success).toBe(true);
  });

  test("rejects show without an id and list with an empty status", () => {
    expect(BeadsRequestSchema.safeParse({ kind: "show" }).success).toBe(false);
    expect(BeadsRequestSchema.safeParse({ kind: "list", status: "" }).success).toBe(false);
  });

  test("rejects an off-envelope kind (e.g. a write)", () => {
    expect(BeadsRequestSchema.safeParse({ kind: "close", id: "GH-228" }).success).toBe(false);
  });
});

describe("beadsd wire contract — response", () => {
  test("accepts an ok verdict carrying a (opaque) result", () => {
    const parsed = BeadsResponseSchema.parse({ status: "ok", result: [{ id: "GH-228" }] });
    expect(parsed.status).toBe("ok");
  });

  test("accepts an error verdict with code + message", () => {
    const parsed = BeadsResponseSchema.parse({ status: "error", code: "not-found", message: "no such id" });
    expect(parsed.status).toBe("error");
    if (parsed.status === "error") expect(parsed.code).toBe("not-found");
  });

  test("rejects an error verdict missing the code", () => {
    expect(BeadsResponseSchema.safeParse({ status: "error", message: "x" }).success).toBe(false);
  });

  test("rejects an unknown status discriminant", () => {
    expect(BeadsResponseSchema.safeParse({ status: "maybe" }).success).toBe(false);
  });
});
