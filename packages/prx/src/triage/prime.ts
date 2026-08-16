// `prx triage prime` (GH-1015) — drive the untriaged count toward 0 in a
// single operator-driven verb. Composes the existing chain:
//   classify → apply → (typePass?) → prioritize{Bulk|Interactive} → promote
// using the GH-1052 `triageMachine` as the source of truth for sequencing
// and decision branches. Prime is a thin loop wrapper:
//   1. Read `triage status` to capture the starting `totalUntriaged`.
//   2. If the queue is already clean, exit 0 with "queue-clean".
//   3. Run one full pass of `triageMachine` with `scope: "prime"` so the
//      out-of-scope orphan/drift/report tail is skipped (kept on tickets
//      #1048/#1049/#1022 per the issue body).
//   4. Re-read status. Stop on: queue-drained | no-progress | blocked |
//      max-iterations.
//
// Prime adds **no** triage logic of its own — every decision lives in the
// machine. The CLI surface only owns: option parsing, the iteration loop,
// stop-condition tracking, and per-iteration / summary line output.

import { createActor } from "xstate";

import {
  triageMachine,
  type TriageBlockedReason,
  type TriageMachineContext,
  type TriageMachineInput,
} from "./machine.ts";
import {
  runStatusActor,
  triageStatusOptionsSchema,
  type TriageStatusActorResult,
  type TriageStatusOptions,
} from "./triage.ts";
import { triagePrimeOptionsSchema, type TriagePrimeOptions } from "./schemas/index.ts";
import { makeAuditInspector } from "../audit/sink.ts";

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type TriagePrimeStopReason =
  | "queue-clean"
  | "queue-drained"
  | "no-progress"
  | "max-iterations"
  | "blocked";

export type TriagePrimeIterationLog = {
  iteration: number;
  before: { totalUntriaged: number; totalOpen: number };
  after: { totalUntriaged: number; totalOpen: number };
  delta: number;
  machineFinalState: "done" | "blocked";
  blockedReason: TriageBlockedReason | null;
  // GH-1125 — counts surfaced from the head-of-machine pruneMerged state.
  // `closedIssues` is what got closed this iteration; `removedWorktrees`
  // stays 0 until GH-1126 ships the worktree-teardown action.
  pruneMerged: {
    closedIssues: number;
    removedWorktrees: number;
  };
};

export type TriagePrimeResult = {
  repo: string | undefined;
  dryRun: boolean;
  autoPrioritize: boolean;
  // GH-1342 — chain `prx triage drift-fix --apply` into each iteration via
  // the machine's `driftFixing` state when totalDrift > 0.
  autoDriftFix: boolean;
  maxIterations: number;
  stopReason: TriagePrimeStopReason;
  iterations: TriagePrimeIterationLog[];
  totalDrained: number;
  blockedReason: TriageBlockedReason | null;
};

export type TriagePrimeDeps = {
  /**
   * Override the machine — typically `triageMachine.provide({ actors })` in
   * tests so the loop runs without touching gh, bd, or disk.
   */
  machine?: typeof triageMachine;
  /**
   * Override the inter-iteration status read. Defaults to `runStatusActor`,
   * which reads the live repo state via gh + bd. Tests inject a sequence so
   * the loop's progression is deterministic.
   */
  loadStatus?: (opts: TriageStatusOptions) => TriageStatusActorResult;
  /**
   * GH-1734: routed cwd from `prx triage prime --repo <slug>`. Defaults
   * to `process.cwd()`. Mirrors the convention in `triage.ts` /
   * `promote.ts` / the four Deps types extended in GH-1697.
   */
  cwd?: () => string;
};

/**
 * Run the `triageMachine` to completion once and surface the final state.
 * Exposed for tests; prime's loop calls it per iteration.
 */
export async function runMachineOnce(
  machine: typeof triageMachine,
  input: TriageMachineInput,
): Promise<{ value: "done" | "blocked"; context: TriageMachineContext }> {
  return new Promise((resolve, reject) => {
    // GH-1403: emit machine state-transition rows to the unified audit sink.
    // Inspector filters to root-actor snapshots so child actors invoked by
    // individual states do not flood the daily NDJSON file.
    const actor = createActor(machine, {
      input,
      inspect: makeAuditInspector("triage"),
    });
    actor.subscribe({
      complete: () => {
        const snap = actor.getSnapshot();
        const value = String(snap.value);
        if (value !== "done" && value !== "blocked") {
          // Should be unreachable: every terminal path in the machine targets
          // either `done` or `blocked`. Surface as a runtime error so a
          // future machine refactor that adds a third terminal state fails
          // loudly here instead of silently misclassifying a run.
          reject(new Error(`triage machine ended in unexpected state: ${value}`));
          return;
        }
        resolve({ value, context: snap.context });
      },
      error: reject,
    });
    actor.start();
  });
}

export function runTriagePrime(
  opts: TriagePrimeOptions,
  output: Output,
  deps: TriagePrimeDeps = {},
): Promise<number> {
  const validated: TriagePrimeOptions = triagePrimeOptionsSchema.parse(opts);
  const machine = deps.machine ?? triageMachine;
  const loadStatus =
    deps.loadStatus ??
    ((statusOpts: TriageStatusOptions) =>
      runStatusActor(statusOpts, deps.cwd ? { cwd: deps.cwd } : {}));

  return runPrimeLoop(validated, output, machine, loadStatus);
}

async function runPrimeLoop(
  opts: TriagePrimeOptions,
  output: Output,
  machine: typeof triageMachine,
  loadStatus: (statusOpts: TriageStatusOptions) => TriageStatusActorResult,
): Promise<number> {
  const statusOpts: TriageStatusOptions = triageStatusOptionsSchema.parse({
    repo: opts.repo,
    format: "json",
    limit: 0,
    includeIntentional: false,
  });

  const iterations: TriagePrimeIterationLog[] = [];
  let blockedReason: TriageBlockedReason | null = null;

  let initial = loadStatus(statusOpts);
  let repo = initial.snapshot.repo;
  let prevUntriaged = initial.snapshot.totalUntriaged;
  let firstUntriaged = prevUntriaged;

  if (opts.format === "plain") {
    output.log(
      `prx triage prime: starting on ${repo} (${prevUntriaged} untriaged of ${initial.snapshot.totalOpen} open, max ${opts.maxIterations} iterations, dry-run=${opts.dryRun}, auto-prioritize=${opts.autoPrioritize}, auto-drift-fix=${opts.autoDriftFix})`,
    );
  }

  if (prevUntriaged === 0) {
    return finish({
      opts,
      repo,
      output,
      iterations,
      blockedReason: null,
      stopReason: "queue-clean",
      firstUntriaged,
      finalUntriaged: 0,
    });
  }

  let stopReason: TriagePrimeStopReason | null = null;

  for (let i = 1; i <= opts.maxIterations; i += 1) {
    const before = {
      totalUntriaged: prevUntriaged,
      totalOpen: initial.snapshot.totalOpen,
    };

    const { value, context } = await runMachineOnce(machine, {
      repo: opts.repo,
      dryRun: opts.dryRun,
      autoPrioritize: opts.autoPrioritize,
      autoDriftFix: opts.autoDriftFix,
      scope: "prime",
    });

    let after: { totalUntriaged: number; totalOpen: number };
    let machineFinalState: "done" | "blocked" = value;
    let iterBlocked: TriageBlockedReason | null = null;

    if (value === "blocked") {
      iterBlocked = context.blockedReason;
      blockedReason = iterBlocked;
      // The machine's pre-promote status snapshot is the most accurate
      // "after" for a blocked run — we never touched the queue past that.
      after = {
        totalUntriaged: context.status?.totalUntriaged ?? prevUntriaged,
        totalOpen: context.status?.totalOpen ?? initial.snapshot.totalOpen,
      };
    } else {
      const next = loadStatus(statusOpts);
      initial = next;
      repo = next.snapshot.repo;
      after = {
        totalUntriaged: next.snapshot.totalUntriaged,
        totalOpen: next.snapshot.totalOpen,
      };
    }

    const delta = before.totalUntriaged - after.totalUntriaged;
    const pruneMerged = {
      closedIssues: context.pruneMergedResult?.closedIssues.length ?? 0,
      removedWorktrees: context.pruneMergedResult?.removedWorktrees.length ?? 0,
    };
    iterations.push({
      iteration: i,
      before,
      after,
      delta,
      machineFinalState,
      blockedReason: iterBlocked,
      pruneMerged,
    });

    if (opts.format === "plain") {
      const pruneSuffix =
        pruneMerged.closedIssues > 0 || pruneMerged.removedWorktrees > 0
          ? `  [pruned ${pruneMerged.closedIssues} stale issues / ${pruneMerged.removedWorktrees} worktrees]`
          : "";
      output.log(
        `iteration ${i}: ${before.totalUntriaged} → ${after.totalUntriaged} untriaged (Δ=${delta >= 0 ? "-" : "+"}${Math.abs(delta)})${pruneSuffix}${
          machineFinalState === "blocked" ? "  [machine blocked]" : ""
        }`,
      );
    }

    if (machineFinalState === "blocked") {
      stopReason = "blocked";
      break;
    }

    if (after.totalUntriaged === 0) {
      stopReason = "queue-drained";
      prevUntriaged = 0;
      break;
    }

    if (delta <= 0) {
      stopReason = "no-progress";
      prevUntriaged = after.totalUntriaged;
      break;
    }

    prevUntriaged = after.totalUntriaged;

    if (i === opts.maxIterations) {
      stopReason = "max-iterations";
      break;
    }
  }

  return finish({
    opts,
    repo,
    output,
    iterations,
    blockedReason,
    stopReason: stopReason ?? "max-iterations",
    firstUntriaged,
    finalUntriaged: prevUntriaged,
  });
}

function finish(args: {
  opts: TriagePrimeOptions;
  repo: string | undefined;
  output: Output;
  iterations: TriagePrimeIterationLog[];
  blockedReason: TriageBlockedReason | null;
  stopReason: TriagePrimeStopReason;
  firstUntriaged: number;
  finalUntriaged: number;
}): number {
  const totalDrained = Math.max(0, args.firstUntriaged - args.finalUntriaged);
  const result: TriagePrimeResult = {
    repo: args.repo,
    dryRun: args.opts.dryRun,
    autoPrioritize: args.opts.autoPrioritize,
    autoDriftFix: args.opts.autoDriftFix,
    maxIterations: args.opts.maxIterations,
    stopReason: args.stopReason,
    iterations: args.iterations,
    totalDrained,
    blockedReason: args.blockedReason,
  };

  if (args.opts.format === "json") {
    args.output.log(JSON.stringify(result, null, 2));
  } else {
    args.output.log(formatPlainSummary(result));
  }

  return args.stopReason === "blocked" ? 1 : 0;
}

function formatPlainSummary(result: TriagePrimeResult): string {
  switch (result.stopReason) {
    case "queue-clean":
      return `prx triage prime: nothing to triage on ${result.repo} (queue already clean).`;
    case "queue-drained":
      return `prx triage prime: done — drained ${result.totalDrained} (queue-drained, ${result.iterations.length} iteration${result.iterations.length === 1 ? "" : "s"}).`;
    case "no-progress":
      return `prx triage prime: stopping — no progress between iterations (drained ${result.totalDrained} across ${result.iterations.length} iteration${result.iterations.length === 1 ? "" : "s"}).`;
    case "max-iterations":
      return `prx triage prime: stopping — hit max-iterations cap (${result.maxIterations}) after draining ${result.totalDrained}.`;
    case "blocked":
      return `prx triage prime: blocked at ${result.blockedReason?.actor ?? "<unknown>"}${
        result.blockedReason?.ticket ? ` (${result.blockedReason.ticket})` : ""
      } — ${result.blockedReason?.message ?? "no message"}`;
  }
}
