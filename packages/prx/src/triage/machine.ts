// XState v5 machine for the `prx triage` workflow (GH-1052).
//
// Lifecycle: load status → classify → apply → (typePass?) → prioritize* →
// promote → (driftFix?) → report → done. Decision pseudo-
// states use eager `always` transitions with guards reading from the status
// snapshot loaded into context. Each invoke target is a Zod-typed
// `fromPromise` actor (real for the four existing verbs + status, stub for
// the five sibling-ticket verbs).
//
// Companion to `prSystem` (src/machine/machines/pr.ts) and `taskRoleMachine`
// (src/machine/machines/task.ts). Per memory `reference_zod_boundary_layer`,
// Zod is the boundary layer; the machine's domain types are XState state
// nodes + assigned-into context, not Zod runtime checks in the hot path.
//
// `onDone` / `onError` actions are inlined rather than named via the `setup`
// `actions` slot. v5 auto-types the event in inline `assign()` bodies but
// loses that narrowing when assigns are hoisted to named actions; inlining
// keeps the actor outputs and rejection errors fully typed.

import { assign, setup } from "xstate";

import {
  applyActor,
  classifyActor,
  driftFixActor,
  prioritizeActor,
  prioritizeBulkActor,
  promoteActor,
  pruneMergedActor,
  reportActor,
  statusActor,
  typePassActor,
  TriageStubError,
} from "./actors.ts";
import type { TriageStatusActorResult } from "./triage.ts";
import type { TriageClassifyActorResult } from "./classifier.ts";
import type { TriageApplyActorResult } from "./apply.ts";
import type { TriagePrioritizeActorResult } from "./prioritize.ts";
import type { TriagePromoteActorResult } from "./promote.ts";
import type { TriagePruneMergedActorResult } from "./prune-merged.ts";
import type { TriageDriftFixActorResult } from "./drift-fix.ts";
import type { TriageStatusSnapshot, TriageMachineEvent } from "./schemas/index.ts";

// ── machine input + context ────────────────────────────────────────────────

/**
 * Input to the triage machine. Becomes the seed context fields not derived
 * from a verb actor.
 */
export type TriageMachineInput = {
  /** Defaults to current repo when undefined. */
  repo?: string | undefined;
  /** When true, all writing verbs run in dry-run mode. */
  dryRun: boolean;
  /**
   * When true, the priority-decision branch routes to `prioritizingBulk`
   * (Haiku-driven) rather than `prioritizingInteractive` (operator prompt).
   * Mirrors the `prx triage prime --auto-prioritize` flag from GH-1015.
   */
  autoPrioritize: boolean;
  /**
   * GH-1342: when true under `scope: "prime"`, route promoting.onDone through
   * `driftDecision` so the drift-fix reconcile actor runs whenever
   * `totalDrift > 0`. Default false preserves the GH-1015 short-circuit
   * (promoting → done). No effect under `scope: "full"`, which already runs
   * the drift tail unconditionally.
   */
  autoDriftFix: boolean;
  /**
   * GH-1015 scope clip. `prime` exits at `promoting.onDone` straight to
   * `done`, skipping the out-of-scope orphan / drift / report stages so
   * `prx triage prime` is shielded from the open verb stubs (#1048 / #1049 /
   * #1022). `full` runs the entire lifecycle. Defaults to `full` so existing
   * machine consumers and tests are unaffected.
   */
  scope?: "prime" | "full";
};

export type TriageBlockedReason = {
  /** Name of the actor whose invoke rejected. */
  actor: string;
  /** Owning ticket from the rejecting `TriageStubError`, when available. */
  ticket: string | null;
  /** Original rejection message. */
  message: string;
};

export type TriageMachineContext = {
  // ── seeded from input ────────────────────────────────────────────────────
  repo: string | undefined;
  dryRun: boolean;
  autoPrioritize: boolean;
  autoDriftFix: boolean;
  scope: "prime" | "full";
  // ── populated by the load-status actor ───────────────────────────────────
  status: TriageStatusSnapshot | null;
  // ── populated by each verb actor's onDone ────────────────────────────────
  pruneMergedResult: TriagePruneMergedActorResult | null;
  classifyResult: TriageClassifyActorResult | null;
  applyResult: TriageApplyActorResult | null;
  prioritizeResult: TriagePrioritizeActorResult | null;
  promoteResult: TriagePromoteActorResult | null;
  driftFixResult: TriageDriftFixActorResult | null;
  // ── failure state ────────────────────────────────────────────────────────
  blockedReason: TriageBlockedReason | null;
};

export const initialTriageMachineContext = (
  input: TriageMachineInput,
): TriageMachineContext => ({
  repo: input.repo,
  dryRun: input.dryRun,
  autoPrioritize: input.autoPrioritize,
  autoDriftFix: input.autoDriftFix,
  scope: input.scope ?? "full",
  status: null,
  pruneMergedResult: null,
  classifyResult: null,
  applyResult: null,
  prioritizeResult: null,
  promoteResult: null,
  driftFixResult: null,
  blockedReason: null,
});

// ── helpers (extracted for guard + test reuse) ─────────────────────────────

export function statusHasTypelessRows(snapshot: TriageStatusSnapshot | null): boolean {
  if (!snapshot) return false;
  return snapshot.issues.some((row) => row.missing.includes("type"));
}

export function statusHasPriorityNoneRows(snapshot: TriageStatusSnapshot | null): boolean {
  if (!snapshot) return false;
  return snapshot.issues.some((row) => row.missing.includes("priority"));
}

export function statusHasDrift(snapshot: TriageStatusSnapshot | null): boolean {
  if (!snapshot) return false;
  return snapshot.totalDrift > 0;
}

// GH-1588: open beads whose linked GH issue is CLOSED. Report-only — no guard /
// state consumes this; remediation is owned by GH-941 / GH-1537.
export function statusHasStale(snapshot: TriageStatusSnapshot | null): boolean {
  if (!snapshot) return false;
  return snapshot.totalStale > 0;
}

// GH-1449: open GH issues carrying ≥2 mutually-exclusive labels on the same
// axis (`type::*` / `priority::*` / `area::*` / `effort::*`). Report-only —
// parallel to `statusHasStale`; no guard wires this into a transition yet
// (a remediation verb is a follow-up ticket).
export function statusHasAxisConflicts(snapshot: TriageStatusSnapshot | null): boolean {
  if (!snapshot) return false;
  return snapshot.totalAxisConflicts > 0;
}

export function blockedReasonFromError(
  actorName: string,
  error: unknown,
): TriageBlockedReason {
  if (error instanceof TriageStubError) {
    return { actor: actorName, ticket: error.ticket, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { actor: actorName, ticket: null, message };
}

// ── machine ────────────────────────────────────────────────────────────────

export const triageMachine = setup({
  types: {
    context: {} as TriageMachineContext,
    events: {} as TriageMachineEvent,
    input: {} as TriageMachineInput,
  },
  actors: {
    statusActor,
    classifyActor,
    applyActor,
    typePassActor,
    prioritizeActor,
    prioritizeBulkActor,
    promoteActor,
    driftFixActor,
    reportActor,
    pruneMergedActor,
  },
  guards: {
    hasTypelessRows: ({ context }) => statusHasTypelessRows(context.status),
    hasPriorityNoneRows: ({ context }) => statusHasPriorityNoneRows(context.status),
    noPriorityNoneRows: ({ context }) => !statusHasPriorityNoneRows(context.status),
    hasDrift: ({ context }) => statusHasDrift(context.status),
    autoPrioritizationEnabled: ({ context }) => context.autoPrioritize,
    // GH-1342: opt-in chain — when prime is running with --auto-drift-fix,
    // route promoting.onDone through `driftDecision` so the drift reconcile
    // actor runs whenever `totalDrift > 0`.
    autoDriftFixEnabled: ({ context }) => context.autoDriftFix,
    // GH-1015: scope clip for `prx triage prime` — exit at promoting.onDone
    // and skip the orphan/drift/reporting tail.
    scopeIsPrime: ({ context }) => context.scope === "prime",
  },
}).createMachine({
  id: "triage",
  initial: "pruneMerged",
  context: ({ input }) => initialTriageMachineContext(input),
  states: {
    // GH-1125: defensive sweep at the head of every triage pass — closes
    // GH issues whose linked PR is already merged so the status snapshot
    // the rest of the machine reads no longer carries merged-PR drift.
    // Runs unconditionally for both `prime` and `full` scopes; no scope
    // guard, since the sweep is strictly additive.
    pruneMerged: {
      invoke: {
        id: "pruneMerged",
        src: "pruneMergedActor",
        input: ({ context }) => ({
          repo: context.repo,
          dryRun: context.dryRun,
        }),
        onDone: {
          target: "loadingStatus",
          actions: assign({
            pruneMergedResult: ({ event }) => event.output,
          }),
        },
        onError: {
          target: "blocked",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("pruneMerged", event.error),
          }),
        },
      },
    },
    loadingStatus: {
      invoke: {
        id: "loadStatus",
        src: "statusActor",
        input: ({ context }) => ({
          repo: context.repo,
          format: "json" as const,
          limit: 0,
          includeIntentional: false,
          rateLimit: false,
          // GH-1786 — the triage machine's status load runs inside the
          // operator session; the refresh trigger is driven from the
          // sibling read verbs, so keep this invocation cheap by opting out.
          maxStaleness: "24h",
          noRefresh: true,
        }),
        onDone: {
          target: "classifying",
          actions: assign({
            status: ({ event }) => event.output.snapshot,
          }),
        },
        onError: {
          target: "blocked",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("loadStatus", event.error),
          }),
        },
      },
    },
    classifying: {
      invoke: {
        id: "classify",
        src: "classifyActor",
        input: ({ context }) => ({
          repo: context.repo,
          format: "json" as const,
          limit: 0,
        }),
        onDone: {
          target: "applying",
          actions: assign({
            classifyResult: ({ event }) => event.output,
          }),
        },
        onError: {
          target: "blocked",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("classify", event.error),
          }),
        },
      },
    },
    applying: {
      invoke: {
        id: "apply",
        src: "applyActor",
        input: ({ context }) => ({
          plan: undefined,
          dryRun: context.dryRun,
          limit: 0,
          repo: context.repo,
          sync: true,
        }),
        onDone: {
          target: "typePassDecision",
          actions: assign({
            applyResult: ({ event }) => event.output,
          }),
        },
        onError: {
          target: "blocked",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("apply", event.error),
          }),
        },
      },
    },
    typePassDecision: {
      always: [
        { target: "typePassing", guard: "hasTypelessRows" },
        { target: "priorityDecision" },
      ],
    },
    typePassing: {
      invoke: {
        id: "typePass",
        src: "typePassActor",
        input: ({ context }) => ({
          repo: context.repo,
          model: "claude-haiku-4-5-20251001",
          batchSize: 30,
          limit: 0,
          dryRun: context.dryRun,
        }),
        onDone: { target: "priorityDecision" },
        onError: {
          target: "blocked",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("typePass", event.error),
          }),
        },
      },
    },
    priorityDecision: {
      always: [
        { target: "promoting", guard: "noPriorityNoneRows" },
        { target: "prioritizingBulk", guard: "autoPrioritizationEnabled" },
        { target: "prioritizingInteractive" },
      ],
    },
    prioritizingBulk: {
      invoke: {
        id: "prioritizeBulk",
        src: "prioritizeBulkActor",
        input: ({ context }) => ({
          repo: context.repo,
          model: "claude-haiku-4-5-20251001",
          batchSize: 30,
          limit: 0,
          dryRun: context.dryRun,
        }),
        onDone: { target: "promoting" },
        onError: {
          target: "blocked",
          actions: assign({
            blockedReason: ({ event }) =>
              blockedReasonFromError("prioritizeBulk", event.error),
          }),
        },
      },
    },
    prioritizingInteractive: {
      invoke: {
        id: "prioritize",
        src: "prioritizeActor",
        input: ({ context }) => ({
          repo: context.repo,
          limit: 0,
          dryRun: context.dryRun,
          sync: true,
        }),
        onDone: {
          target: "promoting",
          actions: assign({
            prioritizeResult: ({ event }) => event.output,
          }),
        },
        onError: {
          target: "blocked",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("prioritize", event.error),
          }),
        },
      },
    },
    promoting: {
      invoke: {
        id: "promote",
        src: "promoteActor",
        input: ({ context }) => ({
          repo: context.repo,
          dryRun: context.dryRun,
          limit: 0,
        }),
        // GH-1015 / GH-1342: scope + auto-drift-fix combine to pick the
        // post-promote branch. First match wins:
        //   1. prime + autoDriftFix → driftDecision (chain reconcile in)
        //   2. prime alone           → done (GH-1015 short-circuit)
        //   3. full                  → driftDecision (existing lifecycle)
        // Under `full`, prime-scope guards never fire so behavior is unchanged.
        onDone: [
          {
            target: "driftDecision",
            guard: ({ context }) =>
              context.scope === "prime" && context.autoDriftFix,
            actions: assign({
              promoteResult: ({ event }) => event.output,
            }),
          },
          {
            target: "done",
            guard: "scopeIsPrime",
            actions: assign({
              promoteResult: ({ event }) => event.output,
            }),
          },
          {
            target: "driftDecision",
            actions: assign({
              promoteResult: ({ event }) => event.output,
            }),
          },
        ],
        onError: {
          target: "blocked",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("promote", event.error),
          }),
        },
      },
    },
    driftDecision: {
      // GH-1342: under prime + autoDriftFix, the post-driftFix path must exit
      // to `done` instead of falling through to the still-stubbed `reporting`
      // state (GH-1022). The clean-drift case is symmetric — prime ends here.
      always: [
        { target: "driftFixing", guard: "hasDrift" },
        { target: "done", guard: "scopeIsPrime" },
        { target: "reporting" },
      ],
    },
    driftFixing: {
      invoke: {
        id: "driftFix",
        src: "driftFixActor",
        input: ({ context }) => ({
          repo: context.repo,
          // The "title" axis is not part of the verb's enum
          // (`driftFixAxisSchema` is type|priority|status). The previous
          // stubbed call hid that; once unstubbed, request only the supported
          // axes so the Zod parse in the actor adapter succeeds.
          axes: ["type", "priority", "status"] as const,
          limit: 0,
          dryRun: context.dryRun,
          // `apply` is forced to true inside `runDriftFixActor`; carry the
          // matching value here so the input matches the parsed
          // `TriageDriftFixOptions` shape pre-parse. `sync` mirrors the
          // verb's default so the bd↔github sync still runs after writes.
          apply: true,
          sync: true,
          // GH-1255 — bd-substrate dedupe + health surfaces. Defaults bake
          // the in-flow behavior here so a follow-up CLI lift (`--no-dupes`,
          // `--no-doctor`, `--doctor-fix`) just threads the operator's
          // override through `TriageMachineInput`. `doctorFix` stays off:
          // the machine never auto-`--fix`s the bd substrate — operator
          // opt-in only.
          includeDupes: true,
          includeDoctor: true,
          applyDupes: true,
          doctorFix: false,
        }),
        // GH-1342: same prime short-circuit as `promoting.onDone` — prime
        // never reaches the report stub.
        onDone: [
          {
            target: "done",
            guard: "scopeIsPrime",
            actions: assign({
              driftFixResult: ({ event }) => event.output,
            }),
          },
          {
            target: "reporting",
            actions: assign({
              driftFixResult: ({ event }) => event.output,
            }),
          },
        ],
        onError: {
          target: "blocked",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("driftFix", event.error),
          }),
        },
      },
    },
    reporting: {
      invoke: {
        id: "report",
        src: "reportActor",
        input: ({ context }) => ({
          repo: context.repo,
          format: "pretty" as const,
          includeFilings: false,
        }),
        onDone: { target: "done" },
        onError: {
          target: "blocked",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("report", event.error),
          }),
        },
      },
    },
    blocked: {
      type: "final",
    },
    done: {
      type: "final",
    },
  },
});

export type TriageMachine = typeof triageMachine;

// Suppress unused warning for the actor result types — these are exported via
// context typing and are part of the public surface for downstream consumers
// (TUI / report). The explicit imports above also document which verb-file
// types the machine re-surfaces.
export type {
  TriageStatusActorResult,
  TriageClassifyActorResult,
  TriageApplyActorResult,
  TriagePrioritizeActorResult,
  TriagePromoteActorResult,
  TriageDriftFixActorResult,
};
