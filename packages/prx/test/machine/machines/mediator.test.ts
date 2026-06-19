// prx-wt5 — mediatorMachine transition tests.
//
// Drives the reconcile lifecycle (idle → detecting → conflicted → resolving →
// continuing → resolved → reconciled), including the multi-step rebase loop
// (continuing → detecting), and the escape path (→ aborted). Asserts the
// documentary context captures lineage (I-MED2) and the per-step counters.

import { describe, expect, test } from "bun:test";
import { createActor } from "xstate";

import { mediatorMachine, type MediatorContext } from "../../../src/machine/machines/mediator.ts";

function startMachine() {
  const actor = createActor(mediatorMachine);
  actor.start();
  return actor;
}

function snapshot(actor: ReturnType<typeof startMachine>): {
  value: unknown;
  context: MediatorContext;
} {
  const snap = actor.getSnapshot();
  return { value: snap.value, context: snap.context };
}

describe("mediatorMachine — success path", () => {
  test("idle → detecting → conflicted → resolving → continuing → resolved → reconciled", () => {
    const actor = startMachine();
    expect(snapshot(actor).value).toBe("idle");

    actor.send({
      type: "CONFLICT_DETECTED",
      uowId: "prx-2xy",
      branch: "prx-2xy",
      baseRef: "origin/main",
      conflictedPaths: [
        "packages/prx/src/pr-state/home-update.ts",
        "packages/prx/test/pr-state/home_update.test.ts",
      ],
    });
    expect(snapshot(actor).value).toBe("detecting");
    // Lineage captured (I-MED2).
    expect(snapshot(actor).context.uowId).toBe("prx-2xy");
    expect(snapshot(actor).context.branch).toBe("prx-2xy");
    expect(snapshot(actor).context.baseRef).toBe("origin/main");
    expect(snapshot(actor).context.conflictedPaths).toHaveLength(2);

    actor.send({
      type: "CONFLICT_CLASSIFIED",
      classifications: [
        {
          path: "packages/prx/src/pr-state/home-update.ts",
          kind: "content",
          side: "both",
        },
        {
          path: "packages/prx/test/pr-state/home_update.test.ts",
          kind: "content",
          side: "theirs",
        },
      ],
    });
    expect(snapshot(actor).value).toBe("conflicted");
    expect(snapshot(actor).context.classifications).toHaveLength(2);

    actor.send({ type: "MEDIATION_STARTED" });
    expect(snapshot(actor).value).toBe("resolving");

    // Two paths resolved (observed, not authored by the mediator).
    actor.send({
      type: "RESOLUTION_OBSERVED",
      path: "packages/prx/src/pr-state/home-update.ts",
    });
    actor.send({
      type: "RESOLUTION_OBSERVED",
      path: "packages/prx/test/pr-state/home_update.test.ts",
    });
    expect(snapshot(actor).value).toBe("resolving");
    expect(snapshot(actor).context.resolvedCount).toBe(2);

    // Intent to `git rebase --continue` (effect owned by git/keeper, I-MED4).
    actor.send({ type: "RECONCILE_CONTINUE_REQUESTED" });
    expect(snapshot(actor).value).toBe("continuing");
    expect(snapshot(actor).context.continueRequests).toBe(1);

    actor.send({ type: "RECONCILE_COMPLETED" });
    expect(snapshot(actor).value).toBe("resolved");

    actor.send({ type: "RESTAGE_REQUESTED", stageRef: "prx-2xy:submit@ready" });
    expect(snapshot(actor).value).toBe("reconciled");
    expect(snapshot(actor).context.restaged).toBe(true);
    // Terminal state — no further transitions.
    expect(actor.getSnapshot().status).toBe("done");
  });

  test("multi-step rebase: continuing → detecting loops, preserving lineage", () => {
    const actor = startMachine();

    actor.send({
      type: "CONFLICT_DETECTED",
      uowId: "prx-2xy",
      branch: "prx-2xy",
      baseRef: "origin/main",
      conflictedPaths: ["a.ts"],
    });
    actor.send({
      type: "CONFLICT_CLASSIFIED",
      classifications: [{ path: "a.ts", kind: "content", side: "both" }],
    });
    actor.send({ type: "MEDIATION_STARTED" });
    actor.send({ type: "RESOLUTION_OBSERVED", path: "a.ts" });
    actor.send({ type: "RECONCILE_CONTINUE_REQUESTED" });
    expect(snapshot(actor).value).toBe("continuing");

    // The replayed continue surfaced the NEXT patch's conflicts.
    actor.send({
      type: "CONFLICT_DETECTED",
      uowId: "IGNORED",
      branch: "IGNORED",
      baseRef: "IGNORED",
      conflictedPaths: ["b.ts"],
    });
    expect(snapshot(actor).value).toBe("detecting");
    // Lineage from the first detection is preserved, not overwritten.
    expect(snapshot(actor).context.uowId).toBe("prx-2xy");
    expect(snapshot(actor).context.branch).toBe("prx-2xy");
    expect(snapshot(actor).context.conflictedPaths).toEqual(["b.ts"]);
    // Fresh patch supersedes the prior classification.
    expect(snapshot(actor).context.classifications).toHaveLength(0);

    actor.send({
      type: "CONFLICT_CLASSIFIED",
      classifications: [{ path: "b.ts", kind: "content", side: "theirs" }],
    });
    actor.send({ type: "MEDIATION_STARTED" });
    actor.send({ type: "RESOLUTION_OBSERVED", path: "b.ts" });
    actor.send({ type: "RECONCILE_CONTINUE_REQUESTED" });
    actor.send({ type: "RECONCILE_COMPLETED" });
    actor.send({ type: "RESTAGE_REQUESTED" });
    expect(snapshot(actor).value).toBe("reconciled");
    // Both continue intents counted across the multi-step rebase.
    expect(snapshot(actor).context.continueRequests).toBe(2);
    expect(snapshot(actor).context.resolvedCount).toBe(2);
  });
});

describe("mediatorMachine — abort path", () => {
  test("conflicted → aborted", () => {
    const actor = startMachine();

    actor.send({
      type: "CONFLICT_DETECTED",
      uowId: "prx-2xy",
      branch: "prx-2xy",
      baseRef: "origin/main",
      conflictedPaths: ["a.ts"],
    });
    actor.send({
      type: "CONFLICT_CLASSIFIED",
      classifications: [{ path: "a.ts", kind: "content", side: "both" }],
    });
    expect(snapshot(actor).value).toBe("conflicted");

    actor.send({ type: "MEDIATION_ABORTED" });
    expect(snapshot(actor).value).toBe("aborted");
    expect(snapshot(actor).context.aborted).toBe(true);
    expect(actor.getSnapshot().status).toBe("done");
  });

  test("resolving → aborted (abort mid-resolution)", () => {
    const actor = startMachine();

    actor.send({
      type: "CONFLICT_DETECTED",
      uowId: "prx-2xy",
      branch: "prx-2xy",
      baseRef: "origin/main",
      conflictedPaths: ["a.ts"],
    });
    actor.send({
      type: "CONFLICT_CLASSIFIED",
      classifications: [{ path: "a.ts", kind: "content", side: "both" }],
    });
    actor.send({ type: "MEDIATION_STARTED" });
    expect(snapshot(actor).value).toBe("resolving");

    actor.send({ type: "MEDIATION_ABORTED" });
    expect(snapshot(actor).value).toBe("aborted");
    expect(snapshot(actor).context.aborted).toBe(true);
  });
});
