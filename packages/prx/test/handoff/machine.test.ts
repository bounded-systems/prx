// GH-1397 — handoffMachine state graph unit tests. Pure machine; every guard
// + transition exercised in isolation.

import { describe, expect, test } from "bun:test";
import { createActor } from "xstate";

import type { HandoffEnvelope } from "../../../machine-schema/src/handoff.ts";
import { handoffMachine } from "../../src/machine/machines/handoff.ts";

const NOW = "2026-05-19T12:00:00.000Z";

function makeEnvelope(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return {
    id: "H1",
    dedupKey: "sha256:" + "0".repeat(64),
    workUnitId: "GH-1397",
    repoSlug: "bdelanghe/ai-home",
    sourceActor: "executor",
    targetActor: "noop",
    intent: { verb: "test.verb", args: { a: 1 } },
    inputRefs: [],
    denialReason: "not-allowlisted-for-role",
    enqueuedAt: NOW,
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    ...overrides,
  } as HandoffEnvelope;
}

function startMachine(envelope: HandoffEnvelope) {
  return createActor(handoffMachine, { input: envelope }).start();
}

describe("handoffMachine", () => {
  test("starts in pending", () => {
    const actor = startMachine(makeEnvelope());
    expect(actor.getSnapshot().value).toBe("pending");
  });

  test("CLAIM transitions pending → claimed and records claimant", () => {
    const actor = startMachine(makeEnvelope());
    actor.send({ type: "CLAIM", claimant: "drainer-A", claimTtlSec: 60, now: NOW });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("claimed");
    expect(snap.context.envelope.status).toBe("claimed");
    expect(snap.context.envelope.claimedBy).toBe("drainer-A");
  });

  test("CLAIM is rejected when already claimed", () => {
    const actor = startMachine(makeEnvelope({ claimedBy: "someone-else", status: "claimed" }));
    // notAlreadyClaimed guard fails → no transition. Start state is still pending
    // (envelope status mismatched is fine for the machine; the guard rules).
    actor.send({ type: "CLAIM", claimant: "drainer-A", claimTtlSec: 60, now: NOW });
    expect(actor.getSnapshot().value).toBe("pending");
  });

  test("claim TTL expiry rolls back to pending", () => {
    const actor = startMachine(makeEnvelope());
    actor.send({ type: "CLAIM", claimant: "drainer-A", claimTtlSec: 60, now: NOW });
    expect(actor.getSnapshot().value).toBe("claimed");
    actor.send({ type: "CLAIM_TTL_EXPIRED", now: NOW });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("pending");
    expect(snap.context.envelope.claimedBy).toBeUndefined();
  });

  test("happy path: pending → claimed → draining → done", () => {
    const actor = startMachine(makeEnvelope());
    actor.send({ type: "CLAIM", claimant: "drainer-A", claimTtlSec: 60, now: NOW });
    actor.send({ type: "DRAIN_STARTED", now: NOW });
    expect(actor.getSnapshot().value).toBe("draining");
    actor.send({ type: "DRAIN_SUCCEEDED", now: NOW });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("done");
    expect(snap.context.envelope.status).toBe("done");
    expect(snap.status).toBe("done"); // terminal final state
  });

  test("DRAIN_FAILED → RETRY (attempts<max) → pending", () => {
    const actor = startMachine(makeEnvelope());
    actor.send({ type: "CLAIM", claimant: "drainer-A", claimTtlSec: 60, now: NOW });
    actor.send({ type: "DRAIN_STARTED", now: NOW });
    actor.send({ type: "DRAIN_FAILED", error: "boom", now: NOW });
    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.envelope.lastError).toBe("boom");
    expect(actor.getSnapshot().context.envelope.attempts).toBe(1);
    actor.send({ type: "RETRY", now: NOW });
    expect(actor.getSnapshot().value).toBe("pending");
    expect(actor.getSnapshot().context.envelope.status).toBe("pending");
  });

  test("RETRY at max attempts transitions to abandoned", () => {
    const actor = startMachine(makeEnvelope({ attempts: 2, maxAttempts: 3 }));
    actor.send({ type: "CLAIM", claimant: "drainer-A", claimTtlSec: 60, now: NOW });
    actor.send({ type: "DRAIN_STARTED", now: NOW });
    actor.send({ type: "DRAIN_FAILED", error: "boom", now: NOW });
    actor.send({ type: "RETRY", now: NOW });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("abandoned");
    expect(snap.context.envelope.status).toBe("abandoned");
  });

  test("ABANDON from failed transitions to abandoned", () => {
    const actor = startMachine(makeEnvelope());
    actor.send({ type: "CLAIM", claimant: "drainer-A", claimTtlSec: 60, now: NOW });
    actor.send({ type: "DRAIN_STARTED", now: NOW });
    actor.send({ type: "DRAIN_FAILED", error: "boom", now: NOW });
    actor.send({ type: "ABANDON", reason: "operator", now: NOW });
    expect(actor.getSnapshot().value).toBe("abandoned");
    expect(actor.getSnapshot().context.envelope.lastError).toBe("operator");
  });

  test("GLOBAL_TTL_EXPIRED from pending → abandoned", () => {
    const actor = startMachine(makeEnvelope());
    actor.send({ type: "GLOBAL_TTL_EXPIRED", now: NOW });
    expect(actor.getSnapshot().value).toBe("abandoned");
  });
});
