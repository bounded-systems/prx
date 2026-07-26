// GH-1015 — `prx triage prime` loop wrapper around the GH-1052 triage machine.
// Uses `triageMachine.provide({ actors })` for the inner machine actors and
// injects a `loadStatus` sequence for the inter-iteration totalUntriaged
// reads, so the loop's stop conditions are exercised deterministically with
// no gh / bd / disk side effects.

import { describe, expect, test } from "bun:test";
import { fromPromise } from "xstate";

import { runTriagePrime, type TriagePrimeResult } from "../../src/triage/prime.ts";
import { triageMachine } from "../../src/triage/machine.ts";
import { TriageStubError } from "../../src/triage/actors.ts";
import type {
  TriageStatusOptions,
  TriageClassifyOptions,
  TriageApplyOptions,
  TriagePromoteOptions,
  TriagePrioritizeOptions,
  TriagePrioritizeBulkOptions,
  TriageStatusSnapshot,
} from "../../src/triage/schemas/index.ts";
import type { TriageStatusActorResult } from "../../src/triage/triage.ts";
import type { TriageClassifyActorResult } from "../../src/triage/classifier.ts";
import type { TriageApplyActorResult } from "../../src/triage/apply.ts";
import type { TriagePromoteActorResult } from "../../src/triage/actors.ts";
import type { TriagePrioritizeActorResult } from "../../src/triage/prioritize.ts";
import type { TriagePrioritizeBulkActorResult } from "../../src/triage/prioritize-bulk.ts";
import type { TriagePruneMergedActorResult } from "../../src/triage/prune-merged.ts";
import type { TriagePruneMergedOptions } from "../../src/triage/schemas/index.ts";

// GH-1125 — head-of-machine merged-only prune sweep stub.
const pruneMergedOk = fromPromise<TriagePruneMergedActorResult, TriagePruneMergedOptions>(
  async () => ({
    exitCode: 0,
    closedIssues: [],
    removedWorktrees: [],
    applyResults: [],
    bdSync: null,
  }),
);

// ── builders ───────────────────────────────────────────────────────────────

function snap(overrides: Partial<TriageStatusSnapshot> = {}): TriageStatusSnapshot {
  return {
    repo: "bdelanghe/ai-home",
    canonical: "gh",
    totalOpen: 100,
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

function rowsForCount(n: number, missing: ("priority" | "type" | "beads-link")[]) {
  return Array.from({ length: n }, (_, i) => ({
    number: 1000 + i,
    title: `untriaged ${i}`,
    url: `https://github.com/bdelanghe/ai-home/issues/${1000 + i}`,
    labels: [],
    beadsId: null,
    missing,
    unknownLabels: [],
    weakSignals: [],
  }));
}

function statusSequence(totals: number[]): {
  loadStatus: (opts: TriageStatusOptions) => TriageStatusActorResult;
  calls: () => number;
} {
  let i = 0;
  return {
    loadStatus: (_opts) => {
      const totalUntriaged = totals[Math.min(i, totals.length - 1)]!;
      i += 1;
      return {
        exitCode: 0,
        snapshot: snap({
          totalUntriaged,
          // Issues array has no functional role in the loop wrapper (which
          // only reads totalUntriaged); empty is fine.
        }),
        stdout: [],
        stderr: [],
      };
    },
    calls: () => i,
  };
}

// Inner-machine actor stubs — all succeed so the machine flows
// loadingStatus → classifying → applying → promoting → done (under
// scope:'prime' — set in the runner).
function machineWithSuccessChain(innerStatusUntriaged = 0) {
  const innerStatus = fromPromise<TriageStatusActorResult, TriageStatusOptions>(async () => ({
    exitCode: 0,
    snapshot: snap({
      totalUntriaged: innerStatusUntriaged,
      issues:
        innerStatusUntriaged > 0
          ? rowsForCount(innerStatusUntriaged, ["priority", "beads-link"])
          : [],
    }),
    stdout: [],
    stderr: [],
  }));
  const classify = fromPromise<TriageClassifyActorResult, TriageClassifyOptions>(async () => ({
    exitCode: 0,
    plan: null,
    stdout: [],
    stderr: [],
  }));
  const apply = fromPromise<TriageApplyActorResult, TriageApplyOptions>(async () => ({
    exitCode: 0,
    audit: [],
    stdout: [],
    stderr: [],
    touchedIssues: [],
  }));
  const promote = fromPromise<TriagePromoteActorResult, TriagePromoteOptions>(async () => ({
    exitCode: 0,
    stdout: [],
    stderr: [],
    promotedBeadIds: [],
  }));
  const prioritizeOk = fromPromise<TriagePrioritizeActorResult, TriagePrioritizeOptions>(
    async () => ({
      exitCode: 0,
      audit: [],
      stdout: [],
      stderr: [],
      touchedIssues: [],
    }),
  );
  const bulkOk = fromPromise<TriagePrioritizeBulkActorResult, TriagePrioritizeBulkOptions>(
    async () => ({
      exitCode: 0,
      audit: [],
      stdout: [],
      stderr: [],
      touchedIssues: [],
      batchCount: 0,
      totalCostUsd: 0,
    }),
  );
  return triageMachine.provide({
    actors: {
      pruneMergedActor: pruneMergedOk,
      statusActor: innerStatus,
      classifyActor: classify,
      applyActor: apply,
      promoteActor: promote,
      prioritizeActor: prioritizeOk,
      prioritizeBulkActor: bulkOk,
    },
  });
}

type CapturedOutput = {
  log: (line: string) => void;
  error: (line: string) => void;
  lines: string[];
  errors: string[];
};

function captureOutput(): CapturedOutput {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
    lines,
    errors,
  };
}

function lastJsonResult(output: CapturedOutput): TriagePrimeResult {
  const last = output.lines[output.lines.length - 1]!;
  return JSON.parse(last) as TriagePrimeResult;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("runTriagePrime — stop conditions", () => {
  test("clean queue → no-op, exit 0, queue-clean", async () => {
    const seq = statusSequence([0]);
    const out = captureOutput();
    const exit = await runTriagePrime(
      {
        repo: "bdelanghe/ai-home",
        dryRun: false,
        autoPrioritize: false,
        autoDriftFix: false,
        maxIterations: 5,
        format: "json",
      },
      out,
      { machine: machineWithSuccessChain(0), loadStatus: seq.loadStatus },
    );
    expect(exit).toBe(0);
    expect(seq.calls()).toBe(1);
    const result = lastJsonResult(out);
    expect(result.stopReason).toBe("queue-clean");
    expect(result.iterations).toHaveLength(0);
    expect(result.totalDrained).toBe(0);
  });

  test("single drain (5 → 0) → queue-drained after 1 iteration", async () => {
    const seq = statusSequence([5, 0]);
    const out = captureOutput();
    const exit = await runTriagePrime(
      {
        repo: "bdelanghe/ai-home",
        dryRun: false,
        autoPrioritize: false,
        autoDriftFix: false,
        maxIterations: 5,
        format: "json",
      },
      out,
      { machine: machineWithSuccessChain(5), loadStatus: seq.loadStatus },
    );
    expect(exit).toBe(0);
    const result = lastJsonResult(out);
    expect(result.stopReason).toBe("queue-drained");
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0]!.before.totalUntriaged).toBe(5);
    expect(result.iterations[0]!.after.totalUntriaged).toBe(0);
    expect(result.iterations[0]!.delta).toBe(5);
    expect(result.totalDrained).toBe(5);
  });

  test("no-progress (5 → 5) stops after 1 iteration", async () => {
    const seq = statusSequence([5, 5]);
    const out = captureOutput();
    const exit = await runTriagePrime(
      {
        repo: "bdelanghe/ai-home",
        dryRun: false,
        autoPrioritize: false,
        autoDriftFix: false,
        maxIterations: 5,
        format: "json",
      },
      out,
      { machine: machineWithSuccessChain(5), loadStatus: seq.loadStatus },
    );
    expect(exit).toBe(0);
    const result = lastJsonResult(out);
    expect(result.stopReason).toBe("no-progress");
    expect(result.iterations).toHaveLength(1);
    expect(result.totalDrained).toBe(0);
  });

  test("max-iterations cap fires when delta keeps shrinking but never hits 0", async () => {
    // 10 → 7 → 5 → 4 → ... maxIterations=3 cap fires after 3 iterations.
    const seq = statusSequence([10, 7, 5, 4]);
    const out = captureOutput();
    const exit = await runTriagePrime(
      {
        repo: "bdelanghe/ai-home",
        dryRun: false,
        autoPrioritize: false,
        autoDriftFix: false,
        maxIterations: 3,
        format: "json",
      },
      out,
      { machine: machineWithSuccessChain(10), loadStatus: seq.loadStatus },
    );
    expect(exit).toBe(0);
    const result = lastJsonResult(out);
    expect(result.stopReason).toBe("max-iterations");
    expect(result.iterations).toHaveLength(3);
    expect(result.totalDrained).toBe(6); // 10 → 4
  });
});

describe("runTriagePrime — blocked propagation", () => {
  test("inner machine block (e.g. interactive prioritize stub) → exit 1, blocked", async () => {
    const seq = statusSequence([3]);
    const out = captureOutput();
    // Use the success-chain machine but override prioritizeActor to throw,
    // and provide a snapshot with priority::none rows so the priorityDecision
    // routes there. autoPrioritize=false so we hit the interactive branch.
    const blockedMachine = machineWithSuccessChain(3).provide({
      actors: {
        statusActor: fromPromise<TriageStatusActorResult, TriageStatusOptions>(async () => ({
          exitCode: 0,
          snapshot: snap({
            totalUntriaged: 3,
            issues: rowsForCount(3, ["priority", "beads-link"]),
          }),
          stdout: [],
          stderr: [],
        })),
        prioritizeActor: fromPromise<TriagePrioritizeActorResult, TriagePrioritizeOptions>(
          async () => {
            throw new TriageStubError("prioritize", "GH-980");
          },
        ),
      },
    });

    const exit = await runTriagePrime(
      {
        repo: "bdelanghe/ai-home",
        dryRun: false,
        autoPrioritize: false,
        autoDriftFix: false,
        maxIterations: 5,
        format: "json",
      },
      out,
      { machine: blockedMachine, loadStatus: seq.loadStatus },
    );
    expect(exit).toBe(1);
    const result = lastJsonResult(out);
    expect(result.stopReason).toBe("blocked");
    expect(result.blockedReason?.actor).toBe("prioritize");
    expect(result.blockedReason?.ticket).toBe("GH-980");
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0]!.machineFinalState).toBe("blocked");
  });
});

describe("runTriagePrime — autoPrioritize routing", () => {
  test("autoPrioritize=true exercises prioritizingBulk branch (no interactive block)", async () => {
    // Snapshot has priority::none rows. Without autoPrioritize, the chain
    // would route to prioritizingInteractive — we leave that actor as a
    // failing stub. With autoPrioritize=true, the bulk branch runs (success
    // stub), promote runs, scope:'prime' exits to done, and the loop sees a
    // post-iteration totalUntriaged of 0.
    const seq = statusSequence([2, 0]);
    const out = captureOutput();
    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: pruneMergedOk,
        statusActor: fromPromise<TriageStatusActorResult, TriageStatusOptions>(async () => ({
          exitCode: 0,
          snapshot: snap({
            totalUntriaged: 2,
            issues: rowsForCount(2, ["priority", "beads-link"]),
          }),
          stdout: [],
          stderr: [],
        })),
        classifyActor: fromPromise<TriageClassifyActorResult, TriageClassifyOptions>(async () => ({
          exitCode: 0,
          plan: null,
          stdout: [],
          stderr: [],
        })),
        applyActor: fromPromise<TriageApplyActorResult, TriageApplyOptions>(async () => ({
          exitCode: 0,
          audit: [],
          stdout: [],
          stderr: [],
          touchedIssues: [],
        })),
        // Interactive must NOT be reached.
        prioritizeActor: fromPromise<TriagePrioritizeActorResult, TriagePrioritizeOptions>(
          async () => {
            throw new Error("interactive prioritize must not run when autoPrioritize=true");
          },
        ),
        prioritizeBulkActor: fromPromise<
          TriagePrioritizeBulkActorResult,
          TriagePrioritizeBulkOptions
        >(async () => ({
          exitCode: 0,
          audit: [],
          stdout: [],
          stderr: [],
          touchedIssues: [],
          batchCount: 1,
          totalCostUsd: 0.01,
        })),
        promoteActor: fromPromise<TriagePromoteActorResult, TriagePromoteOptions>(async () => ({
          exitCode: 0,
          stdout: [],
          stderr: [],
          promotedBeadIds: [],
        })),
      },
    });

    const exit = await runTriagePrime(
      {
        repo: "bdelanghe/ai-home",
        dryRun: false,
        autoPrioritize: true,
        autoDriftFix: false,
        maxIterations: 5,
        format: "json",
      },
      out,
      { machine, loadStatus: seq.loadStatus },
    );
    expect(exit).toBe(0);
    const result = lastJsonResult(out);
    expect(result.stopReason).toBe("queue-drained");
    expect(result.autoPrioritize).toBe(true);
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0]!.machineFinalState).toBe("done");
    expect(result.totalDrained).toBe(2);
  });
});

describe("runTriagePrime — plain output", () => {
  test("plain format emits header + per-iteration line + summary", async () => {
    const seq = statusSequence([3, 0]);
    const out = captureOutput();
    const exit = await runTriagePrime(
      {
        repo: "bdelanghe/ai-home",
        dryRun: true,
        autoPrioritize: false,
        autoDriftFix: false,
        maxIterations: 5,
        format: "plain",
      },
      out,
      { machine: machineWithSuccessChain(3), loadStatus: seq.loadStatus },
    );
    expect(exit).toBe(0);
    expect(out.lines.length).toBeGreaterThanOrEqual(3);
    expect(out.lines[0]).toContain("starting on bdelanghe/ai-home");
    expect(out.lines[0]).toContain("dry-run=true");
    expect(out.lines[0]).toContain("auto-drift-fix=false");
    expect(out.lines.find((l) => l.startsWith("iteration 1:"))).toBeDefined();
    expect(out.lines[out.lines.length - 1]).toContain("queue-drained");
  });
});

// GH-1342 — `--auto-drift-fix` threads through into the machine input and
// surfaces on TriagePrimeResult / the plain-mode banner.
describe("runTriagePrime — autoDriftFix routing", () => {
  test("autoDriftFix=true + drift>0 → driftFixActor runs once per iteration, exit 0", async () => {
    let driftFixCalls = 0;
    const driftOk = fromPromise<
      import("../../src/triage/actors.ts").TriageDriftFixActorResult,
      import("../../src/triage/actors.ts").DriftFixActorInput
    >(async () => {
      driftFixCalls += 1;
      return {
        exitCode: 0,
        stdout: [],
        stderr: [],
        writes: 2,
        skips: 0,
        errors: 0,
        touchedIssues: [501, 502],
      };
    });

    // Status sequence: 4 untriaged + drift -> drains to 0.
    const seq = statusSequence([4, 0]);
    const out = captureOutput();
    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: pruneMergedOk,
        statusActor: fromPromise<TriageStatusActorResult, TriageStatusOptions>(async () => ({
          exitCode: 0,
          snapshot: snap({
            totalUntriaged: 4,
            totalDrift: 2,
            issues: rowsForCount(4, ["beads-link"]),
          }),
          stdout: [],
          stderr: [],
        })),
        classifyActor: fromPromise<TriageClassifyActorResult, TriageClassifyOptions>(async () => ({
          exitCode: 0,
          plan: null,
          stdout: [],
          stderr: [],
        })),
        applyActor: fromPromise<TriageApplyActorResult, TriageApplyOptions>(async () => ({
          exitCode: 0,
          audit: [],
          stdout: [],
          stderr: [],
          touchedIssues: [],
        })),
        promoteActor: fromPromise<TriagePromoteActorResult, TriagePromoteOptions>(async () => ({
          exitCode: 0,
          stdout: [],
          stderr: [],
          promotedBeadIds: [],
        })),
        driftFixActor: driftOk,
      },
    });

    const exit = await runTriagePrime(
      {
        repo: "bdelanghe/ai-home",
        dryRun: false,
        autoPrioritize: false,
        autoDriftFix: true,
        maxIterations: 5,
        format: "json",
      },
      out,
      { machine, loadStatus: seq.loadStatus },
    );
    expect(exit).toBe(0);
    expect(driftFixCalls).toBe(1);
    const result = lastJsonResult(out);
    expect(result.autoDriftFix).toBe(true);
    expect(result.stopReason).toBe("queue-drained");
  });

  test("autoDriftFix=false default → driftFixActor never invoked even when drift>0", async () => {
    let driftFixCalls = 0;
    const driftMustNotRun = fromPromise<
      import("../../src/triage/actors.ts").TriageDriftFixActorResult,
      import("../../src/triage/actors.ts").DriftFixActorInput
    >(async () => {
      driftFixCalls += 1;
      throw new Error("must not run");
    });

    const seq = statusSequence([2, 0]);
    const out = captureOutput();
    const machine = triageMachine.provide({
      actors: {
        pruneMergedActor: pruneMergedOk,
        statusActor: fromPromise<TriageStatusActorResult, TriageStatusOptions>(async () => ({
          exitCode: 0,
          snapshot: snap({
            totalUntriaged: 2,
            totalDrift: 5,
            issues: rowsForCount(2, ["beads-link"]),
          }),
          stdout: [],
          stderr: [],
        })),
        classifyActor: fromPromise<TriageClassifyActorResult, TriageClassifyOptions>(async () => ({
          exitCode: 0,
          plan: null,
          stdout: [],
          stderr: [],
        })),
        applyActor: fromPromise<TriageApplyActorResult, TriageApplyOptions>(async () => ({
          exitCode: 0,
          audit: [],
          stdout: [],
          stderr: [],
          touchedIssues: [],
        })),
        promoteActor: fromPromise<TriagePromoteActorResult, TriagePromoteOptions>(async () => ({
          exitCode: 0,
          stdout: [],
          stderr: [],
          promotedBeadIds: [],
        })),
        driftFixActor: driftMustNotRun,
      },
    });

    const exit = await runTriagePrime(
      {
        repo: "bdelanghe/ai-home",
        dryRun: false,
        autoPrioritize: false,
        autoDriftFix: false,
        maxIterations: 5,
        format: "json",
      },
      out,
      { machine, loadStatus: seq.loadStatus },
    );
    expect(exit).toBe(0);
    expect(driftFixCalls).toBe(0);
    const result = lastJsonResult(out);
    expect(result.autoDriftFix).toBe(false);
  });
});
