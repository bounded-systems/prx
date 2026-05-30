// GH-1397 — handoff envelope schema + dedupKey canonicalization tests.

import { describe, expect, test } from "bun:test";

import {
  handoffDenialReason,
  handoffEnvelope,
  handoffStatus,
  handoffTargetActor,
} from "../../../machine-schema/src/handoff.ts";

const NOW = "2026-05-19T12:00:00.000Z";

function baseInput(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "H01_abc",
    dedupKey: "sha256:" + "0".repeat(64),
    workUnitId: "GH-1397",
    repoSlug: "bdelanghe/ai-home",
    sourceActor: "executor",
    targetActor: "publisher",
    intent: { verb: "git.push", args: { branch: "GH-1397" } },
    denialReason: "not-allowlisted-for-role",
    enqueuedAt: NOW,
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

describe("handoffEnvelope schema", () => {
  test("round-trips a minimal envelope", () => {
    const parsed = handoffEnvelope.parse(baseInput());
    expect(parsed.id).toBe("H01_abc");
    expect(parsed.targetActor).toBe("publisher");
    expect(parsed.status).toBe("pending");
    expect(parsed.inputRefs).toEqual([]);
    expect(parsed.attempts).toBe(0);
  });

  test("rejects an unknown target actor", () => {
    const result = handoffEnvelope.safeParse(baseInput({ targetActor: "unknown" }));
    expect(result.success).toBe(false);
  });

  test("rejects an unknown denial reason", () => {
    const result = handoffEnvelope.safeParse(baseInput({ denialReason: "made-up" }));
    expect(result.success).toBe(false);
  });

  test("accepts the four denial reasons + four recipient actors + noop", () => {
    for (const r of handoffDenialReason.options) {
      const parsed = handoffEnvelope.parse(baseInput({ denialReason: r }));
      expect(parsed.denialReason).toBe(r);
    }
    for (const t of handoffTargetActor.options) {
      const parsed = handoffEnvelope.parse(baseInput({ targetActor: t }));
      expect(parsed.targetActor).toBe(t);
    }
  });

  test("status enum covers the six lifecycle states", () => {
    for (const s of handoffStatus.options) {
      const parsed = handoffEnvelope.parse(baseInput({ status: s }));
      expect(parsed.status).toBe(s);
    }
  });

  test("policyKey is optional but typed when present", () => {
    const parsed = handoffEnvelope.parse(
      baseInput({
        policyKey: { tool: "git", subcommand: "push", state: "validating", role: "executor" },
      }),
    );
    expect(parsed.policyKey?.subcommand).toBe("push");
  });

  test("inputRefs default to empty array when omitted", () => {
    const parsed = handoffEnvelope.parse(baseInput());
    expect(parsed.inputRefs).toEqual([]);
  });

  test("attempts must be non-negative; maxAttempts must be positive", () => {
    expect(handoffEnvelope.safeParse(baseInput({ attempts: -1 })).success).toBe(false);
    expect(handoffEnvelope.safeParse(baseInput({ maxAttempts: 0 })).success).toBe(false);
  });
});
