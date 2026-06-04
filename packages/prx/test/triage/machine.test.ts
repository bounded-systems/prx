// GH-1052 — triage XState machine transition coverage. Each test provides
// fake actors via `triageMachine.provide({ actors })` so we exercise the
// state graph without touching gh, bd, or disk.

import { describe, expect, test } from "bun:test";
import { createActor, fromPromise } from "xstate";

import {
  triageMachine,
  type TriageMachineContext,
  type TriageMachineInput,
} from "../../src/triage/machine.ts";
import { TriageStubError } from "../../src/triage/actors.ts";
import type {
  TriageStatusSnapshot,
  TriageStatusOptions,
  TriageClassifyOptions,
  TriageApplyOptions,
  TriagePrioritizeOptions,
  TriagePromoteOptions,
  TriageTypePassOptions,
  TriagePrioritizeBulkOptions,
  TriageDriftFixOptions,
  TriageReportOptions,
} from "../../src/triage/schemas/index.ts";
import type { TriageStatusActorResult } from "../../src/triage/triage.ts";
import type { TriageClassifyActorResult } from "../../src/triage/classifier.ts";
import type { TriageApplyActorResult } from "../../src/triage/apply.ts";
import type { TriagePrioritizeActorResult } from "../../src/triage/prioritize.ts";
import type { TriagePromoteActorResult } from "../../src/triage/promote.ts";
import type { TriageTypePassActorResult } from "../../src/triage/type-pass.ts";
import type { TriagePrioritizeBulkActorResult } from "../../src/triage/prioritize-bulk.ts";
import type { TriagePruneMergedActorResult } from "../../src/triage/prune-merged.ts";
import type { TriageDriftFixActorResult } from "../../src/triage/drift-fix.ts";
import type { TriagePruneMergedOptions } from "../../src/triage/schemas/index.ts";

// ── builders ───────────────────────────────────────────────────────────────

function snapshot(overrides: Partial<TriageStatusSnapshot> = {}): TriageStatusSnapshot {
  return {
    repo: "bdelanghe/ai-home",
    canonical: "gh",
    totalOpen: 0,
    totalUntriaged: 0,
    totalReverseOrphans: 0,
    totalDrift: 0,
    totalStale: 0,
    totalAxisConflicts: 0,
    issues: [],
    reverseOrphans: [],
    drift: [],
    stale: [],
    axisConflicts: [],
    ...overrides,
  };
}

function fakeStatusActor(snap: TriageStatusSnapshot) {
  return fromPromise<TriageStatusActorResult, TriageStatusOptions>(async () => ({
    exitCode: 0,
    snapshot: snap,
    stdout: [],
    stderr: [],
  }));
}

const fakeClassifyOk = fromPromise<TriageClassifyActorResult, TriageClassifyOptions>(
  async () => ({ exitCode: 0, plan: null, stdout: [], stderr: [] }),
);

const fakeApplyOk = fromPromise<TriageApplyActorResult, TriageApplyOptions>(
  async () => ({ exitCode: 0, audit: [], stdout: [], stderr: [], touchedIssues: [] }),
);

const fakePrioritizeOk = fromPromise<TriagePrioritizeActorResult, TriagePrioritizeOptions>(
  async () => ({ exitCode: 0, audit: [], stdout: [], stderr: [], touchedIssues: [] }),
);

const fakePromoteOk = fromPromise<TriagePromoteActorResult, TriagePromoteOptions>(
  async () => ({
    exitCode: 0,
    plan: null,
    audit: [],
    stdout: [],
    stderr: [],
    promotedBeadIds: [],
  }),
);

// GH-1021 — typePassActor is a real verb now; tests use this success stub
// instead of the prior rejecting stub, which kept the type-pass branch
// blocked. Helper retained (un-exported, scoped) for parity with the other
// `fake<Verb>Ok` helpers.
const fakeTypePassOk = fromPromise<TriageTypePassActorResult, TriageTypePassOptions>(
  async () => ({ exitCode: 0, audit: [], stdout: [], stderr: [], touchedIssues: [] }),
);

// GH-1125 — head-of-machine merged-only prune sweep. Stub returns a clean
// no-op so the rest of the state graph runs unchanged in existing tests.
const fakePruneMergedOk = fromPromise<
  TriagePruneMergedActorResult,
  TriagePruneMergedOptions
>(async () => ({
  exitCode: 0,
  closedIssues: [],
  removedWorktrees: [],
  applyResults: [],
  bdSync: null,
}));
function rejectingPrioritizeBulkActor(ticket: string) {
  return fromPromise<TriagePrioritizeBulkActorResult, TriagePrioritizeBulkOptions>(
    async () => {
      throw new TriageStubError("prioritize-bulk", ticket);
    },
  );
}
function rejectingPrioritizeActor() {
  return fromPromise<TriagePrioritizeActorResult, TriagePrioritizeOptions>(async () => {
    throw new Error("STUBBED prioritize");
  });
}
function rejectingDriftFixActor(ticket: string) {
  // GH-1342: driftFixActor is now wired to a real verb returning
  // `TriageDriftFixActorResult`. The output type widens from `never`
  // to the actor's result type so the rejecting test stub still
  // satisfies the typed actor slot the machine expects.
  return fromPromise<TriageDriftFixActorResult, TriageDriftFixOptions>(async () => {
    throw new TriageStubError("drift-fix", ticket);
  });
}
function rejectingReportActor(ticket: string) {
  return fromPromise<never, TriageReportOptions>(async () => {
    throw new TriageStubError("report", ticket);
  });
}

const baseInput: TriageMachineInput = {
  repo: "bdelanghe/ai-home",
  dryRun: true,
  autoPrioritize: false,
  autoDriftFix: false,
};

/**
 * Run the machine to its first final state and resolve with the snapshot's
 * value + context.
 */
async function runToCompletion(
  machine: typeof triageMachine,
  input: TriageMachineInput = baseInput,
): Promise<{ value: string; context: TriageMachineContext }> {
  return new Promise((resolve, reject) => {
    const actor = createActor(machine, { input });
    actor.subscribe({
      complete: () => {
        const snap = actor.getSnapshot();
        resolve({ value: String(snap.value), context: snap.context });
      },
      error: reject,
    });
    actor.start();
  });
}

// ── happy-path tests (real actors stubbed to success) ──────────────────────

describe("triageMachine — decision-state branching", () => {
  test("clean queue → routes through to reporting (stub) and blocks on report", async () => {
    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: fakePruneMergedOk,
        statusActor: fakeStatusActor(snapshot()),
        classifyActor: fakeClassifyOk,
        applyActor: fakeApplyOk,
        promoteActor: fakePromoteOk,
        reportActor: rejectingReportActor("GH-1022"),
      },
    });

    const { value, context } = await runToCompletion(machine);
    expect(value).toBe("blocked");
    expect(context.blockedReason?.actor).toBe("report");
    expect(context.blockedReason?.ticket).toBe("GH-1022");
    expect(context.status).not.toBeNull();
    expect(context.classifyResult).not.toBeNull();
    expect(context.applyResult).not.toBeNull();
    expect(context.promoteResult).not.toBeNull();
  });

  test("typeless rows → enters typePassing, resolves, then continues to priorityDecision", async () => {
    // GH-1021 — typePassActor is now a real verb. The machine should run it
    // and continue to priorityDecision instead of blocking. We stub the actor
    // here to keep this test pure (no spawn, no gh) and assert the machine
    // takes the typeless branch and lands at the next blocker (report stub).
    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: fakePruneMergedOk,
        statusActor: fakeStatusActor(
          snapshot({
            totalOpen: 1,
            totalUntriaged: 1,
            issues: [
              {
                number: 100,
                title: "untyped issue",
                url: "https://github.com/bdelanghe/ai-home/issues/100",
                labels: ["priority::low"],
                beadsId: null,
                missing: ["type", "beads-link"],
                unknownLabels: [],
                weakSignals: [],
              },
            ],
          }),
        ),
        classifyActor: fakeClassifyOk,
        applyActor: fakeApplyOk,
        typePassActor: fakeTypePassOk,
        promoteActor: fakePromoteOk,
        reportActor: rejectingReportActor("GH-1022"),
      },
    });

    const { value, context } = await runToCompletion(machine);
    expect(value).toBe("blocked");
    // Confirms type-pass ran cleanly; the block is now at the report stub.
    expect(context.blockedReason?.actor).toBe("report");
    expect(context.blockedReason?.ticket).toBe("GH-1022");
  });

  test("priority::none + autoPrioritize=false → prioritizingInteractive", async () => {
    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: fakePruneMergedOk,
        statusActor: fakeStatusActor(
          snapshot({
            totalOpen: 1,
            totalUntriaged: 1,
            issues: [
              {
                number: 200,
                title: "unscored",
                url: "https://github.com/bdelanghe/ai-home/issues/200",
                labels: ["type::feature", "priority::none"],
                beadsId: null,
                missing: ["priority", "beads-link"],
                unknownLabels: [],
                weakSignals: [],
              },
            ],
          }),
        ),
        classifyActor: fakeClassifyOk,
        applyActor: fakeApplyOk,
        prioritizeActor: rejectingPrioritizeActor(),
        promoteActor: fakePromoteOk,
        reportActor: rejectingReportActor("GH-1022"),
      },
    });

    const { value, context } = await runToCompletion(machine, {
      ...baseInput,
      autoPrioritize: false,
    });
    expect(value).toBe("blocked");
    expect(context.blockedReason?.actor).toBe("prioritize");
  });

  test("priority::none + autoPrioritize=true → prioritizingBulk (stub)", async () => {
    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: fakePruneMergedOk,
        statusActor: fakeStatusActor(
          snapshot({
            totalOpen: 1,
            totalUntriaged: 1,
            issues: [
              {
                number: 201,
                title: "unscored auto",
                url: "https://github.com/bdelanghe/ai-home/issues/201",
                labels: ["type::feature"],
                beadsId: null,
                missing: ["priority", "beads-link"],
                unknownLabels: [],
                weakSignals: [],
              },
            ],
          }),
        ),
        classifyActor: fakeClassifyOk,
        applyActor: fakeApplyOk,
        prioritizeBulkActor: rejectingPrioritizeBulkActor("GH-1047"),
        promoteActor: fakePromoteOk,
        reportActor: rejectingReportActor("GH-1022"),
      },
    });

    const { value, context } = await runToCompletion(machine, {
      ...baseInput,
      autoPrioritize: true,
    });
    expect(value).toBe("blocked");
    expect(context.blockedReason?.actor).toBe("prioritizeBulk");
    expect(context.blockedReason?.ticket).toBe("GH-1047");
  });

  // GH-1047 — positive path: prioritizeBulkActor resolves cleanly, machine
  // proceeds to promoting and on to reporting. Validates that the spine
  // `prioritizingBulk.onDone` plumbing matches the new actor's
  // `TriagePrioritizeBulkActorResult` return type without any context assign.
  test("priority::none + autoPrioritize=true + bulk success → promoting → done path", async () => {
    const fakeBulkOk = fromPromise<
      TriagePrioritizeBulkActorResult,
      TriagePrioritizeBulkOptions
    >(async () => ({
      exitCode: 0,
      audit: [],
      stdout: [],
      stderr: [],
      touchedIssues: [],
      batchCount: 0,
      totalCostUsd: 0,
    }));
    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: fakePruneMergedOk,
        statusActor: fakeStatusActor(
          snapshot({
            totalOpen: 1,
            totalUntriaged: 1,
            issues: [
              {
                number: 202,
                title: "unscored auto OK",
                url: "https://github.com/bdelanghe/ai-home/issues/202",
                labels: ["type::feature"],
                beadsId: null,
                missing: ["priority", "beads-link"],
                unknownLabels: [],
                weakSignals: [],
              },
            ],
          }),
        ),
        classifyActor: fakeClassifyOk,
        applyActor: fakeApplyOk,
        prioritizeBulkActor: fakeBulkOk,
        promoteActor: fakePromoteOk,
        reportActor: rejectingReportActor("GH-1022"),
      },
    });

    const { value, context } = await runToCompletion(machine, {
      ...baseInput,
      autoPrioritize: true,
    });
    // Reaches reporting and blocks there (report actor still a stub) — proves
    // the bulk → promoting transition fired and promote ran successfully.
    expect(value).toBe("blocked");
    expect(context.blockedReason?.actor).toBe("report");
    expect(context.promoteResult).not.toBeNull();
  });

  test("reverse orphans present → driftDecision → reporting (no orphan push, GH-1718)", async () => {
    // GH-1718: `triage push-orphans` retired. Reverse-orphan signals no
    // longer influence machine flow — the path is promote → driftDecision
    // → reporting regardless of `totalReverseOrphans`. prx-3f1: reverse-orphans
    // are the normal beads-first state (informational only), not projected into
    // next_work's triage_backlog; an operator may still publish manually via
    // `prx beads publish <bd-id>` if a GH mirror is genuinely wanted.
    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: fakePruneMergedOk,
        statusActor: fakeStatusActor(
          snapshot({
            totalReverseOrphans: 1,
            reverseOrphans: [
              {
                beadsId: "ai-home-abcd",
                title: "orphan bead",
                status: "open",
                priority: "medium",
                issueType: "task",
                reason: "no-external-ref",
              },
            ],
          }),
        ),
        classifyActor: fakeClassifyOk,
        applyActor: fakeApplyOk,
        promoteActor: fakePromoteOk,
        reportActor: rejectingReportActor("GH-1022"),
      },
    });

    const { value, context } = await runToCompletion(machine);
    expect(value).toBe("blocked");
    expect(context.blockedReason?.actor).toBe("report");
    expect(context.blockedReason?.ticket).toBe("GH-1022");
  });

  test("drift present → driftFixing (stub)", async () => {
    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: fakePruneMergedOk,
        statusActor: fakeStatusActor(
          snapshot({
            totalDrift: 1,
            drift: [
              {
                issueNumber: 300,
                beadsId: "ai-home-zzz",
                fields: { type: { gh: "feature", bd: "task" } },
              },
            ],
          }),
        ),
        classifyActor: fakeClassifyOk,
        applyActor: fakeApplyOk,
        promoteActor: fakePromoteOk,
        driftFixActor: rejectingDriftFixActor("GH-1049"),
        reportActor: rejectingReportActor("GH-1022"),
      },
    });

    const { value, context } = await runToCompletion(machine);
    expect(value).toBe("blocked");
    expect(context.blockedReason?.actor).toBe("driftFix");
    expect(context.blockedReason?.ticket).toBe("GH-1049");
  });
});

describe("triageMachine — failure handling", () => {
  test("loadStatus rejection → blocked with no ticket (non-stub error)", async () => {
    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: fakePruneMergedOk,
        statusActor: fromPromise<TriageStatusActorResult, TriageStatusOptions>(
          async () => {
            throw new Error("gh down");
          },
        ),
        classifyActor: fakeClassifyOk,
        applyActor: fakeApplyOk,
        promoteActor: fakePromoteOk,
        reportActor: rejectingReportActor("GH-1022"),
      },
    });
    const { value, context } = await runToCompletion(machine);
    expect(value).toBe("blocked");
    expect(context.blockedReason?.actor).toBe("loadStatus");
    expect(context.blockedReason?.ticket).toBeNull();
    expect(context.blockedReason?.message).toBe("gh down");
  });

  test("classify rejection → blocked on classify", async () => {
    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: fakePruneMergedOk,
        statusActor: fakeStatusActor(snapshot()),
        classifyActor: fromPromise<
          TriageClassifyActorResult,
          TriageClassifyOptions
        >(async () => {
          throw new Error("boom");
        }),
        applyActor: fakeApplyOk,
        promoteActor: fakePromoteOk,
        reportActor: rejectingReportActor("GH-1022"),
      },
    });
    const { value, context } = await runToCompletion(machine);
    expect(value).toBe("blocked");
    expect(context.blockedReason?.actor).toBe("classify");
  });
});

describe("triageMachine — initial context", () => {
  test("seeds context from input", async () => {
    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: fakePruneMergedOk,
        statusActor: fromPromise<TriageStatusActorResult, TriageStatusOptions>(
          async () => {
            throw new Error("seed");
          },
        ),
        classifyActor: fakeClassifyOk,
        applyActor: fakeApplyOk,
        promoteActor: fakePromoteOk,
        reportActor: rejectingReportActor("GH-1022"),
      },
    });
    const { context } = await runToCompletion(machine, {
      repo: "owner/foo",
      dryRun: true,
      autoPrioritize: true,
      autoDriftFix: false,
    });
    expect(context.repo).toBe("owner/foo");
    expect(context.dryRun).toBe(true);
    expect(context.autoPrioritize).toBe(true);
    expect(context.autoDriftFix).toBe(false);
  });

  test("scope defaults to 'full' when omitted", async () => {
    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: fakePruneMergedOk,
        statusActor: fromPromise<TriageStatusActorResult, TriageStatusOptions>(
          async () => {
            throw new Error("seed");
          },
        ),
        classifyActor: fakeClassifyOk,
        applyActor: fakeApplyOk,
        promoteActor: fakePromoteOk,
        reportActor: rejectingReportActor("GH-1022"),
      },
    });
    const { context } = await runToCompletion(machine);
    expect(context.scope).toBe("full");
  });
});

// GH-1015 — `scope: "prime"` clips the lifecycle at `promoting.onDone`. The
// outer `prx triage prime` loop is then free to drive the chain repeatedly
// without bumping into the orphan / drift / report stubs (#1048/#1049/#1022).
describe("triageMachine — GH-1015 scope clip", () => {
  test("scope:'prime' lands in 'done' after promote, skipping orphan/drift/report", async () => {
    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: fakePruneMergedOk,
        // Provide orphan + drift signals AND keep the drift / report
        // stubs in place. Under `scope: 'full'` the same setup blocks at
        // the report stub (drift route); under `scope: 'prime'` we expect
        // 'done' because the machine exits at promote.
        statusActor: fakeStatusActor(
          snapshot({
            totalOpen: 2,
            totalReverseOrphans: 1,
            totalDrift: 1,
            reverseOrphans: [
              {
                beadsId: "ai-home-abcd",
                title: "orphan bead",
                status: "open",
                priority: "medium",
                issueType: "task",
                reason: "no-external-ref",
              },
            ],
            drift: [
              {
                issueNumber: 300,
                beadsId: "ai-home-zzz",
                fields: { type: { gh: "feature", bd: "task" } },
              },
            ],
          }),
        ),
        classifyActor: fakeClassifyOk,
        applyActor: fakeApplyOk,
        promoteActor: fakePromoteOk,
        // Stubs left rejecting on purpose — the scope branch must skip them.
        // The report actor (GH-1022) still rejects, so if the scope clip
        // failed the machine would land in `blocked` at `report`, not `done`.
        driftFixActor: rejectingDriftFixActor("GH-1049"),
        reportActor: rejectingReportActor("GH-1022"),
      },
    });

    const { value, context } = await runToCompletion(machine, {
      ...baseInput,
      scope: "prime",
    });
    expect(value).toBe("done");
    expect(context.scope).toBe("prime");
    expect(context.promoteResult).not.toBeNull();
    expect(context.blockedReason).toBeNull();
  });
});

// GH-1342 — `scope: "prime"` + `autoDriftFix: true` opts back into the drift
// reconcile actor without re-enabling the `reporting` stub. Three cases:
//   1. drift > 0 + autoDriftFix=true → driftFixing runs, lands in done
//   2. drift = 0 + autoDriftFix=true → driftDecision short-circuits to done
//      (the prime scope guard fires before falling into `reporting`)
//   3. drift > 0 + autoDriftFix=false → existing GH-1015 short-circuit holds
//      (machine exits at promoting.onDone without invoking driftFixActor)
describe("triageMachine — GH-1342 prime + autoDriftFix", () => {
  test("prime + autoDriftFix=true + drift>0 → driftFixing runs, lands in done", async () => {
    let driftFixCalls = 0;
    const driftOk = fromPromise<TriageDriftFixActorResult, TriageDriftFixOptions>(
      async () => {
        driftFixCalls += 1;
        return {
          exitCode: 0,
          audit: [],
          stdout: [],
          stderr: [],
          writes: 1,
          skips: 0,
          errors: 0,
          syncOutcome: "ok",
          touchedIssues: [42],
          duplicatesDetected: 0,
          mergesApplied: 0,
          mergesSkippedParity: 0,
          substrateHealth: { total: 0, fixable: 0, fixed: false },
        };
      },
    );

    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: fakePruneMergedOk,
        statusActor: fakeStatusActor(
          snapshot({
            totalDrift: 1,
            drift: [
              {
                issueNumber: 42,
                beadsId: "ai-home-drift1",
                fields: { type: { gh: "feature", bd: "task" } },
              },
            ],
          }),
        ),
        classifyActor: fakeClassifyOk,
        applyActor: fakeApplyOk,
        promoteActor: fakePromoteOk,
        driftFixActor: driftOk,
        // Report stub left rejecting — if the prime+autoDriftFix path falls
        // into reporting, the test fails on blocked at report.
        reportActor: rejectingReportActor("GH-1022"),
      },
    });

    const { value, context } = await runToCompletion(machine, {
      ...baseInput,
      scope: "prime",
      autoDriftFix: true,
    });
    expect(value).toBe("done");
    expect(driftFixCalls).toBe(1);
    expect(context.autoDriftFix).toBe(true);
    expect(context.driftFixResult?.writes).toBe(1);
    expect(context.blockedReason).toBeNull();
  });

  test("prime + autoDriftFix=true + drift=0 → driftDecision skips to done (never invokes report stub)", async () => {
    let driftFixCalls = 0;
    const driftMustNotRun = fromPromise<TriageDriftFixActorResult, TriageDriftFixOptions>(
      async () => {
        driftFixCalls += 1;
        throw new Error("driftFixActor must not run when totalDrift===0");
      },
    );

    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: fakePruneMergedOk,
        statusActor: fakeStatusActor(snapshot({ totalDrift: 0 })),
        classifyActor: fakeClassifyOk,
        applyActor: fakeApplyOk,
        promoteActor: fakePromoteOk,
        driftFixActor: driftMustNotRun,
        reportActor: rejectingReportActor("GH-1022"),
      },
    });

    const { value, context } = await runToCompletion(machine, {
      ...baseInput,
      scope: "prime",
      autoDriftFix: true,
    });
    expect(value).toBe("done");
    expect(driftFixCalls).toBe(0);
    expect(context.driftFixResult).toBeNull();
    expect(context.blockedReason).toBeNull();
  });

  // GH-1255 — the `driftFixing` invoke input grows four new fields that
// thread the bd-substrate dedupe + health surfaces through the actor. The
// machine bakes in `includeDupes:true, includeDoctor:true, applyDupes:true,
// doctorFix:false` at this single call site; assert the actor sees them.
  test("driftFixing invoke passes GH-1255 dupe + doctor flags to the actor input", async () => {
    const observed: { input: TriageDriftFixOptions | null } = { input: null };
    const driftCapture = fromPromise<TriageDriftFixActorResult, TriageDriftFixOptions>(
      async ({ input }) => {
        observed.input = input;
        return {
          exitCode: 0,
          audit: [],
          stdout: [],
          stderr: [],
          writes: 0,
          skips: 0,
          errors: 0,
          syncOutcome: "skipped",
          touchedIssues: [],
          duplicatesDetected: 0,
          mergesApplied: 0,
          mergesSkippedParity: 0,
          substrateHealth: { total: 0, fixable: 0, fixed: false },
        };
      },
    );

    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: fakePruneMergedOk,
        statusActor: fakeStatusActor(
          snapshot({
            totalDrift: 1,
            drift: [
              {
                issueNumber: 42,
                beadsId: "ai-home-drift-flags",
                fields: { type: { gh: "feature", bd: "task" } },
              },
            ],
          }),
        ),
        classifyActor: fakeClassifyOk,
        applyActor: fakeApplyOk,
        promoteActor: fakePromoteOk,
        driftFixActor: driftCapture,
        reportActor: rejectingReportActor("GH-1022"),
      },
    });

    await runToCompletion(machine, {
      ...baseInput,
      scope: "prime",
      autoDriftFix: true,
    });
    expect(observed.input).not.toBeNull();
    expect(observed.input?.includeDupes).toBe(true);
    expect(observed.input?.includeDoctor).toBe(true);
    expect(observed.input?.applyDupes).toBe(true);
    expect(observed.input?.doctorFix).toBe(false);
  });

  test("prime + autoDriftFix=false + drift>0 → GH-1015 short-circuit holds (skips driftFixing)", async () => {
    let driftFixCalls = 0;
    const driftMustNotRun = fromPromise<TriageDriftFixActorResult, TriageDriftFixOptions>(
      async () => {
        driftFixCalls += 1;
        throw new Error("driftFixActor must not run when autoDriftFix=false");
      },
    );

    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: fakePruneMergedOk,
        statusActor: fakeStatusActor(
          snapshot({
            totalDrift: 1,
            drift: [
              {
                issueNumber: 99,
                beadsId: "ai-home-skip",
                fields: { type: { gh: "feature", bd: "task" } },
              },
            ],
          }),
        ),
        classifyActor: fakeClassifyOk,
        applyActor: fakeApplyOk,
        promoteActor: fakePromoteOk,
        driftFixActor: driftMustNotRun,
        reportActor: rejectingReportActor("GH-1022"),
      },
    });

    const { value, context } = await runToCompletion(machine, {
      ...baseInput,
      scope: "prime",
      autoDriftFix: false,
    });
    expect(value).toBe("done");
    expect(driftFixCalls).toBe(0);
    expect(context.driftFixResult).toBeNull();
  });
});

// GH-1125 — `pruneMerged` is the first state in the machine. It runs for
// both `prime` and `full` scopes; on success the result lands in context
// and the machine proceeds to `loadingStatus`. On failure the machine
// blocks at `pruneMerged` and surfaces the actor name.
describe("triageMachine — GH-1125 pruneMerged head state", () => {
  test("scope:'prime' threads pruneMergedResult into context and continues to loadingStatus", async () => {
    const closed = [1048, 1049];
    const customPruneActor = fromPromise<
      TriagePruneMergedActorResult,
      TriagePruneMergedOptions
    >(async () => ({
      exitCode: 0,
      closedIssues: closed,
      removedWorktrees: [],
      applyResults: [],
      bdSync: { exitCode: 0, stdout: "", stderr: "" },
    }));

    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: customPruneActor,
        statusActor: fakeStatusActor(snapshot()),
        classifyActor: fakeClassifyOk,
        applyActor: fakeApplyOk,
        promoteActor: fakePromoteOk,
      },
    });

    const { value, context } = await runToCompletion(machine, {
      ...baseInput,
      scope: "prime",
    });
    expect(value).toBe("done");
    expect(context.pruneMergedResult?.closedIssues).toEqual(closed);
    expect(context.blockedReason).toBeNull();
  });

  test("pruneMergedActor rejection → blocked at pruneMerged before any other actor runs", async () => {
    const rejectingPrune = fromPromise<
      TriagePruneMergedActorResult,
      TriagePruneMergedOptions
    >(async () => {
      throw new Error("gh rate limit");
    });

    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: rejectingPrune,
        statusActor: fromPromise<TriageStatusActorResult, TriageStatusOptions>(
          async () => {
            throw new Error("status must not run when pruneMerged failed");
          },
        ),
      },
    });

    const { value, context } = await runToCompletion(machine);
    expect(value).toBe("blocked");
    expect(context.blockedReason?.actor).toBe("pruneMerged");
    expect(context.blockedReason?.ticket).toBeNull();
    expect(context.blockedReason?.message).toBe("gh rate limit");
    expect(context.status).toBeNull();
  });
});
