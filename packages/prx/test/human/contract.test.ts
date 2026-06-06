import { describe, expect, test } from "bun:test";

import {
  HUMAN_REQUEST_KINDS,
  HumanRequestSchema,
  HumanResponseSchema,
} from "../../src/human/contract.ts";

describe("human-actor contract — request envelope", () => {
  test("the envelope is an enumerable allowlist (no wildcard)", () => {
    expect(HUMAN_REQUEST_KINDS).toEqual(["decision", "approval", "secret-op"]);
  });

  test("accepts a well-formed decision (>= 2 options)", () => {
    const parsed = HumanRequestSchema.parse({
      kind: "decision",
      question: "merge now or wait for review?",
      options: ["merge", "wait"],
    });
    expect(parsed.kind).toBe("decision");
  });

  test("rejects a decision with fewer than two options — not a real decision", () => {
    expect(
      HumanRequestSchema.safeParse({ kind: "decision", question: "?", options: ["only"] }).success,
    ).toBe(false);
  });

  test("accepts approval and secret-op asks", () => {
    expect(HumanRequestSchema.safeParse({ kind: "approval", action: "force-push main" }).success).toBe(true);
    expect(HumanRequestSchema.safeParse({ kind: "secret-op", op: "rotate keeper key" }).success).toBe(true);
  });

  test("rejects an off-envelope request kind", () => {
    expect(HumanRequestSchema.safeParse({ kind: "run-shell", command: "rm -rf /" }).success).toBe(false);
  });
});

describe("human-actor contract — response", () => {
  test("accepts a kind-matched decision/approval/secret-op reply", () => {
    expect(HumanResponseSchema.safeParse({ kind: "decision", choice: "merge" }).success).toBe(true);
    expect(HumanResponseSchema.safeParse({ kind: "approval", approved: false, reason: "scope too broad" }).success).toBe(true);
    expect(HumanResponseSchema.safeParse({ kind: "secret-op", done: true, note: "rotated" }).success).toBe(true);
  });

  test("rejects an approval reply missing the boolean verdict", () => {
    expect(HumanResponseSchema.safeParse({ kind: "approval", reason: "ok" }).success).toBe(false);
  });

  test("rejects an unknown response kind", () => {
    expect(HumanResponseSchema.safeParse({ kind: "granted-ambient-authority" }).success).toBe(false);
  });
});
