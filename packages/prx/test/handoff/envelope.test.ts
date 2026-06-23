// GH-1397 — handoff envelope schema + dedupKey canonicalization tests.

import { describe, expect, test } from "bun:test";

import {
  parseHandoffEnvelope,
  HANDOFF_TARGET_ACTOR_VALUES,
} from "@bounded-systems/machine-schema";
import type {
  HandoffDenialReason,
  HandoffStatus,
  HandoffTargetActor,
} from "@bounded-systems/machine-schema";

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

function safeParse(raw: unknown): { success: true } | { success: false } {
  try {
    parseHandoffEnvelope(raw);
    return { success: true };
  } catch {
    return { success: false };
  }
}

// v0.3.0 replaced Zod schemas with parse functions + typed unions.
// Use inline value arrays instead of schema.options.
const DENIAL_REASON_VALUES: readonly HandoffDenialReason[] = [
  "blocked",
  "not-allowlisted-for-role",
  "unknown-tool",
  "flag-layer-deny",
];
const STATUS_VALUES: readonly HandoffStatus[] = [
  "pending",
  "claimed",
  "draining",
  "done",
  "failed",
  "abandoned",
];

describe("HandoffEnvelope schema", () => {
  test("round-trips a minimal envelope", () => {
    const parsed = parseHandoffEnvelope(baseInput());
    expect(parsed.id).toBe("H01_abc");
    expect(parsed.targetActor).toBe("publisher");
    expect(parsed.status).toBe("pending");
    expect(parsed.inputRefs).toEqual([]);
    expect(parsed.attempts).toBe(0);
  });

  test("rejects an unknown target actor", () => {
    const result = safeParse(baseInput({ targetActor: "unknown" }));
    expect(result.success).toBe(false);
  });

  test("rejects an unknown denial reason", () => {
    const result = safeParse(baseInput({ denialReason: "made-up" }));
    expect(result.success).toBe(false);
  });

  test("accepts the four denial reasons + six recipient actors", () => {
    for (const r of DENIAL_REASON_VALUES) {
      const parsed = parseHandoffEnvelope(baseInput({ denialReason: r }));
      expect(parsed.denialReason).toBe(r);
    }
    for (const t of HANDOFF_TARGET_ACTOR_VALUES) {
      const parsed = parseHandoffEnvelope(baseInput({ targetActor: t }));
      expect(parsed.targetActor).toBe(t as HandoffTargetActor);
    }
  });

  test("status enum covers the six lifecycle states", () => {
    for (const s of STATUS_VALUES) {
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
    expect(safeParse(baseInput({ attempts: -1 })).success).toBe(false);
    expect(safeParse(baseInput({ maxAttempts: 0 })).success).toBe(false);
  });
});
