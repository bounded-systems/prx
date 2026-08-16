// GH-1537 — per-pair `domainSyncMachine` transition coverage. Actors are
// swapped via `domainSyncMachine.provide({ actors })` so the state graph runs
// without touching `gh` / `bd`. Asserts the lifecycle (idle → pulling →
// pushing → done | failed), the `needsClose` decision threading through
// context, and the DOMAIN_SYNC_* emit sequence.

import { describe, expect, test } from "bun:test";
import { createActor, fromPromise } from "xstate";

import { domainSyncMachine, type DomainSyncPairInput } from "../../src/sync/machine.ts";
import type { PullActorInput, PushActorInput } from "../../src/sync/actors.ts";
import type { DomainSyncPullResult, DomainSyncPushResult } from "../../src/sync/schemas.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";

function bead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "bd-204",
    title: "Periodic beads↔external sync",
    description: "body",
    status: "open",
    priority: 1,
    issueType: "task",
    externalRef: "https://github.com/bdelanghe/ai-home/issues/204",
    externalRefs: { gh: "https://github.com/bdelanghe/ai-home/issues/204" },
    metadata: null,
    externalIssueNumber: 204,
    sourceSystem: null,
    ...overrides,
  };
}

function input(overrides: Partial<DomainSyncPairInput> = {}): DomainSyncPairInput {
  return {
    bead: bead(),
    domain: "gh",
    externalId: "https://github.com/bdelanghe/ai-home/issues/204",
    dryRun: false,
    ...overrides,
  };
}

const okPull = (needsClose: boolean) =>
  fromPromise<DomainSyncPullResult, PullActorInput>(async () => ({
    beadId: "bd-204",
    externalId: "https://github.com/bdelanghe/ai-home/issues/204",
    externalStatus: needsClose ? "closed" : "open",
    beadStatusBefore: "open",
    needsClose,
  }));

const okPush = (edited: boolean) =>
  fromPromise<DomainSyncPushResult, PushActorInput>(async () => ({
    beadId: "bd-204",
    externalId: "https://github.com/bdelanghe/ai-home/issues/204",
    edited,
  }));

const failingPull = fromPromise<DomainSyncPullResult, PullActorInput>(async () => {
  throw new Error("gh issue view boom");
});

function waitForDone(actor: ReturnType<typeof createActor>): Promise<void> {
  return new Promise((resolve) => {
    if (actor.getSnapshot().status === "done") return resolve();
    actor.subscribe((s) => {
      if (s.status === "done") resolve();
    });
  });
}

function collectEmits(actor: ReturnType<typeof createActor>): string[] {
  const events: string[] = [];
  actor.on("*", (e) => events.push(e.type));
  return events;
}

describe("domainSyncMachine — happy path", () => {
  test("idle → pulling → pushing → done; needsClose flows into context", async () => {
    const machine = domainSyncMachine.provide({
      actors: { pullActor: okPull(true), pushActor: okPush(true) },
    });
    const actor = createActor(machine, { input: input() });
    const emits = collectEmits(actor);
    actor.start();
    await waitForDone(actor);
    const final = actor.getSnapshot();
    expect(String(final.value)).toBe("done");
    expect(final.context.pullResult?.needsClose).toBe(true);
    expect(final.context.pushResult?.edited).toBe(true);
    expect(final.context.blockedReason).toBeNull();
    expect(emits).toContain("DOMAIN_SYNC_PAIR_STARTED");
    expect(emits).toContain("DOMAIN_SYNC_PULLED");
    expect(emits).toContain("DOMAIN_SYNC_PUSHED");
    expect(emits).toContain("DOMAIN_SYNC_PAIR_DONE");
    expect(emits).not.toContain("DOMAIN_SYNC_PAIR_FAILED");
    expect(emits.indexOf("DOMAIN_SYNC_PULLED")).toBeLessThan(emits.indexOf("DOMAIN_SYNC_PUSHED"));
    expect(emits.indexOf("DOMAIN_SYNC_PUSHED")).toBeLessThan(
      emits.indexOf("DOMAIN_SYNC_PAIR_DONE"),
    );
  });

  test("dry-run carries through to the push actor input", async () => {
    let sawDryRun: boolean | undefined;
    const machine = domainSyncMachine.provide({
      actors: {
        pullActor: okPull(false),
        pushActor: fromPromise<DomainSyncPushResult, PushActorInput>(async ({ input: i }) => {
          sawDryRun = i.dryRun;
          return { beadId: "bd-204", externalId: "x", edited: false };
        }),
      },
    });
    const actor = createActor(machine, { input: input({ dryRun: true }) });
    actor.start();
    await waitForDone(actor);
    expect(sawDryRun).toBe(true);
  });
});

describe("domainSyncMachine — GH-2095 push_deferred terminal", () => {
  test("pushAllowed=false routes pulling.onDone to push_deferred (no push invocation)", async () => {
    let pushInvoked = false;
    const machine = domainSyncMachine.provide({
      actors: {
        pullActor: okPull(false),
        pushActor: fromPromise<DomainSyncPushResult, PushActorInput>(async () => {
          pushInvoked = true;
          return { beadId: "bd-204", externalId: "x", edited: true };
        }),
      },
    });
    const actor = createActor(machine, { input: input({ pushAllowed: false }) });
    const emits = collectEmits(actor);
    actor.start();
    await waitForDone(actor);
    const final = actor.getSnapshot();
    expect(String(final.value)).toBe("push_deferred");
    expect(final.context.pullResult).not.toBeNull();
    expect(final.context.pushResult).toBeNull();
    expect(pushInvoked).toBe(false);
    expect(emits).toContain("DOMAIN_SYNC_PAIR_STARTED");
    expect(emits).toContain("DOMAIN_SYNC_PULLED");
    expect(emits).toContain("DOMAIN_SYNC_PAIR_PUSH_DEFERRED");
    expect(emits).not.toContain("DOMAIN_SYNC_PUSHED");
    expect(emits).not.toContain("DOMAIN_SYNC_PAIR_DONE");
  });

  test("prefilledPullResult short-circuits idle → pushing (no pull invocation)", async () => {
    let pullInvoked = false;
    const machine = domainSyncMachine.provide({
      actors: {
        pullActor: fromPromise<DomainSyncPullResult, PullActorInput>(async () => {
          pullInvoked = true;
          return {
            beadId: "bd-204",
            externalId: "https://github.com/bdelanghe/ai-home/issues/204",
            externalStatus: "open",
            beadStatusBefore: "open",
            needsClose: false,
          };
        }),
        pushActor: okPush(true),
      },
    });
    const prefilled: DomainSyncPullResult = {
      beadId: "bd-204",
      externalId: "https://github.com/bdelanghe/ai-home/issues/204",
      externalStatus: "closed",
      beadStatusBefore: "open",
      needsClose: true,
    };
    const actor = createActor(machine, {
      input: input({ prefilledPullResult: prefilled }),
    });
    const emits = collectEmits(actor);
    actor.start();
    await waitForDone(actor);
    const final = actor.getSnapshot();
    expect(String(final.value)).toBe("done");
    expect(pullInvoked).toBe(false);
    expect(final.context.pullResult).toEqual(prefilled);
    expect(final.context.pushResult?.edited).toBe(true);
    // No DOMAIN_SYNC_PULLED emit on the skip path — it's the prior phase
    // machine that already emitted it.
    expect(emits).not.toContain("DOMAIN_SYNC_PULLED");
    expect(emits).toContain("DOMAIN_SYNC_PUSHED");
    expect(emits).toContain("DOMAIN_SYNC_PAIR_DONE");
  });
});

describe("domainSyncMachine — failure path", () => {
  test("a pull rejection routes to `failed` and records blockedReason", async () => {
    const machine = domainSyncMachine.provide({
      actors: { pullActor: failingPull, pushActor: okPush(true) },
    });
    const actor = createActor(machine, { input: input() });
    const emits = collectEmits(actor);
    actor.start();
    await waitForDone(actor);
    const final = actor.getSnapshot();
    expect(String(final.value)).toBe("failed");
    expect(final.context.blockedReason?.actor).toBe("pull");
    expect(final.context.blockedReason?.message).toContain("boom");
    expect(final.context.pushResult).toBeNull();
    expect(emits).toContain("DOMAIN_SYNC_PAIR_STARTED");
    expect(emits).toContain("DOMAIN_SYNC_PAIR_FAILED");
    expect(emits).not.toContain("DOMAIN_SYNC_PULLED");
    expect(emits).not.toContain("DOMAIN_SYNC_PUSHED");
  });
});
