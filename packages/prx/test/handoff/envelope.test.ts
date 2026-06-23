// GH-1397 — handoff envelope schema + dedupKey canonicalization tests.

import { describe, expect, test } from "bun:test";

import {
  HANDOFF_TARGET_ACTOR_VALUES,
  parseHandoffEnvelope,
  type HandoffDenialReason,
  type HandoffEnvelope,
  type HandoffStatus,
} from "@bounded-systems/machine-schema";

const HANDOFF_DENIAL_REASON_VALUES: readonly HandoffDenialReason[] = [
  "blocked",
  "not-allowlisted-for-role",
  "unknown-tool",
  "flag-layer-deny",
];

const HANDOFF_STATUS_VALUES: readonly HandoffStatus[] = [
  "pending",
  "claimed",
  "draining",
  "done",
  "failed",
  "abandoned",
];

function safeParseEnvelope(
  input: unknown,
): { success: true; data: HandoffEnvelope } | { success: false } {
  try {
    return { success: true, data: parseHandoffEnvelope(input) };
  } catch {
    return { success: false };
  }
}

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
    const parsed = parseHandoffEnvelope(baseInput());
    expect(parsed.id).toBe("H01_abc");
    expect(parsed.targetActor).toBe("publisher");
    expect(parsed.status).toBe("pending");
    expect(parsed.inputRefs).toEqual([]);
    expect(parsed.attempts).toBe(0);
  });

  test("rejects an unknown target actor", () => {
    const result = safeParseEnvelope(baseInput({ targetActor: "unknown" }));
    expect(result.success).toBe(false);
  });

  test("rejects an unknown denial reason", () => {
    const result = safeParseEnvelope(baseInput({ denialReason: "made-up" }));
    expect(result.success).toBe(false);
  });

  test("accepts the four denial reasons + four recipient actors + noop", () => {
    for (const r of HANDOFF_DENIAL_REASON_VALUES) {
      const parsed = parseHandoffEnvelope(baseInput({ denialReason: r }));
      expect(parsed.denialReason).toBe(r);
    }
    for (const t of HANDOFF_TARGET_ACTOR_VALUES) {
      const parsed = parseHandoffEnvelope(baseInput({ targetActor: t }));
      expect(parsed.targetActor).toBe(t);
    }
  });

  test("status enum covers the six lifecycle states", () => {
    for (const s of HANDOFF_STATUS_VALUES) {
      const parsed = parseHandoffEnvelope(baseInput({ status: s }));
      expect(parsed.status).toBe(s);
    }
  });

  test("policyKey is optional but typed when present", () => {
    const parsed = parseHandoffEnvelope(
      baseInput({
        policyKey: { tool: "git", subcommand: "push", state: "validating", role: "executor" },
      }),
    );
    expect(parsed.policyKey?.subcommand).toBe("push");
  });

  test("inputRefs default to empty array when omitted", () => {
    const parsed = parseHandoffEnvelope(baseInput());
    expect(parsed.inputRefs).toEqual([]);
  });

  test("attempts must be non-negative; maxAttempts must be positive", () => {
    expect(safeParseEnvelope(baseInput({ attempts: -1 })).success).toBe(false);
    expect(safeParseEnvelope(baseInput({ maxAttempts: 0 })).success).toBe(false);
  });
});
