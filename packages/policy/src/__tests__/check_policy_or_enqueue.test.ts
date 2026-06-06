// GH-1397 — checkPolicyOrEnqueue: the deny-with-handoff sibling of checkPolicy.
// Covers all five outcome branches against the real policy table, with the
// bd/CAS write injected via `deps.enqueue` so no handoff infrastructure runs.

import { describe, expect, test } from "bun:test";

import {
  checkPolicyOrEnqueue,
  type CheckPolicyOrEnqueueDeps,
} from "@bounded-systems/policy";

describe("checkPolicyOrEnqueue", () => {
  test("an allowed action returns the decision and never enqueues", async () => {
    // git push at validating:executor is in the allowlist.
    const enqueue: CheckPolicyOrEnqueueDeps["enqueue"] = async () => {
      throw new Error("must not enqueue for an allowed action");
    };
    const r = await checkPolicyOrEnqueue("git", "push", "validating", "executor", {
      enqueue,
    });
    expect(r.allowed).toBe(true);
    expect(r.enqueueSkipped).toBeUndefined();
    expect(r.handoffId).toBeUndefined();
  });

  test("a hard-blocked verb skips enqueue with no-owning-role", async () => {
    // git reset is in BLOCKED — no role can run it, so no recipient exists.
    const r = await checkPolicyOrEnqueue("git", "reset", "validating", "executor");
    expect(r.allowed).toBe(false);
    expect(r.enqueueSkipped).toBe("no-owning-role");
  });

  test("a denied verb that no role owns at this state skips enqueue", async () => {
    // git push is owned only at validating/merging — at planning no role can
    // run it, so findOwningRoles is empty.
    const r = await checkPolicyOrEnqueue("git", "push", "planning", "planner");
    expect(r.allowed).toBe(false);
    expect(r.enqueueSkipped).toBe("no-owning-role");
  });

  test("a denied-but-owned verb with no enqueue dep reports enqueue-disabled", async () => {
    // push is denied for planner@validating but owned by executor/keeper there.
    const r = await checkPolicyOrEnqueue("git", "push", "validating", "planner");
    expect(r.allowed).toBe(false);
    expect(r.enqueueSkipped).toBe("enqueue-disabled");
  });

  test("a denied-but-owned verb enqueues and surfaces the handoffId", async () => {
    const r = await checkPolicyOrEnqueue("git", "push", "validating", "planner", {
      enqueue: async ({ owningRoles }) => {
        // The owning roles are passed through so the recipient can be chosen.
        expect(owningRoles).toContain("keeper");
        return { kind: "enqueued", handoffId: "H-TEST-1" };
      },
    });
    expect(r.allowed).toBe(false);
    expect(r.handoffId).toBe("H-TEST-1");
    expect(r.enqueueSkipped).toBeUndefined();
  });

  test("a skipped enqueue surfaces the skip reason", async () => {
    const r = await checkPolicyOrEnqueue("git", "push", "validating", "planner", {
      enqueue: async () => ({ kind: "skipped", reason: "bd-unprovisioned" }),
    });
    expect(r.allowed).toBe(false);
    expect(r.enqueueSkipped).toBe("bd-unprovisioned");
  });
});
