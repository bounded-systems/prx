// prx-wt5 — `mediatorMachine` for `prx mediator <verb>`.
//
// Documentary state machine for merge-conflict reconciliation. When main
// advances under an open work-unit branch, the branch must rebase onto the
// moved base before submit; this machine is the documentary projection of
// that reconcile lifecycle. The `mediator` *facilitates* — it never imposes a
// resolution (that is the future `arbiter` sibling) and it writes NOTHING to
// the working tree (I-MED1): resolution edits stay with the operator, and the
// `git rebase --continue/--abort` EFFECTS stay owned by `git`/`keeper`
// (I-MED4, the same intent⟂effect split as keeper⟂git). The machine emits the
// `RECONCILE_CONTINUE_REQUESTED` intent only.
//
// Lifecycle (multi-step rebase aware — `continue` may surface the NEXT
// patch's conflicts, looping back to `detecting`):
//
//   idle ──CONFLICT_DETECTED──▶ detecting ──CONFLICT_CLASSIFIED──▶ conflicted
//   conflicted ──MEDIATION_STARTED──▶ resolving
//   resolving ──RESOLUTION_OBSERVED──▶ resolving           (per-path, observed)
//   resolving ──RECONCILE_CONTINUE_REQUESTED──▶ continuing (intent → git/keeper)
//   continuing ──CONFLICT_DETECTED──▶ detecting            (next patch conflicts)
//   continuing ──RECONCILE_COMPLETED──▶ resolved           (clean tree; I-MED3)
//   resolved ──RESTAGE_REQUESTED──▶ reconciled (final)     (→ `prx submit stage`)
//   {conflicted,resolving,continuing} ──MEDIATION_ABORTED──▶ aborted (final)
//
// I-MED2: every event carries `uow_id` + `branch` + `base_ref` (grounds
// I-AUD1/I-AUD2); the context below captures them from `CONFLICT_DETECTED`.
// Pattern: `fetchMachine` (src/machine/machines/fetch.ts) — explicit
// guards/actions/context, no invoked actors, no I/O. The detector
// orchestrator that emits these events, the `RESTAGE_REQUESTED` →
// `prx submit stage` handoff, and the `arbiter` auto-resolve sibling land in
// child tickets.

import { assign, setup } from "xstate";

// How a single conflicted path arose. Mirrors git's conflict taxonomy.
export type ConflictKind =
  | "content"
  | "add_add"
  | "delete_modify"
  | "modify_delete"
  | "rename";

// Which side carried the change relative to the rebase. During a rebase
// `ours` is the (moved) base being replayed onto; `theirs` is the work-unit
// branch's incoming patch.
export type ConflictSide = "ours" | "theirs" | "both";

export type ConflictClassification = {
  path: string;
  kind: ConflictKind;
  side: ConflictSide;
};

export type MediatorContext = {
  // Lineage (I-MED2) — captured from CONFLICT_DETECTED, never overwritten with
  // null on later events.
  uowId: string | null;
  branch: string | null;
  baseRef: string | null;
  // Latest detection / classification snapshots (documentary).
  conflictedPaths: string[];
  classifications: ConflictClassification[];
  // Counters across the (possibly multi-step) rebase.
  resolvedCount: number;
  continueRequests: number;
  // Terminal markers.
  aborted: boolean;
  restaged: boolean;
};

export const initialMediatorContext: MediatorContext = {
  uowId: null,
  branch: null,
  baseRef: null,
  conflictedPaths: [],
  classifications: [],
  resolvedCount: 0,
  continueRequests: 0,
  aborted: false,
  restaged: false,
};

export type MediatorEvent =
  | {
      type: "CONFLICT_DETECTED";
      uowId: string;
      branch: string;
      baseRef: string;
      conflictedPaths: string[];
    }
  | { type: "CONFLICT_CLASSIFIED"; classifications: ConflictClassification[] }
  | { type: "MEDIATION_STARTED" }
  | { type: "RESOLUTION_OBSERVED"; path: string }
  | { type: "RECONCILE_CONTINUE_REQUESTED" }
  | { type: "MEDIATION_ABORTED" }
  | { type: "RECONCILE_COMPLETED" }
  | { type: "RESTAGE_REQUESTED"; stageRef?: string };

export const mediatorMachine = setup({
  types: {
    context: {} as MediatorContext,
    events: {} as MediatorEvent,
  },
  actions: {
    recordDetection: assign(({ context, event }) => {
      if (event.type !== "CONFLICT_DETECTED") return {};
      return {
        // First detection seeds lineage; later loops keep the original ids.
        uowId: context.uowId ?? event.uowId,
        branch: context.branch ?? event.branch,
        baseRef: context.baseRef ?? event.baseRef,
        conflictedPaths: event.conflictedPaths,
        // A fresh patch's conflicts supersede the prior classification.
        classifications: [],
      };
    }),
    recordClassification: assign(({ event }) => {
      if (event.type !== "CONFLICT_CLASSIFIED") return {};
      return { classifications: event.classifications };
    }),
    recordResolution: assign(({ context, event }) => {
      if (event.type !== "RESOLUTION_OBSERVED") return {};
      return { resolvedCount: context.resolvedCount + 1 };
    }),
    recordContinueRequest: assign(({ context, event }) => {
      if (event.type !== "RECONCILE_CONTINUE_REQUESTED") return {};
      return { continueRequests: context.continueRequests + 1 };
    }),
    markAborted: assign(() => ({ aborted: true })),
    markRestaged: assign(() => ({ restaged: true })),
  },
}).createMachine({
  id: "mediatorSystem",
  initial: "idle",
  context: initialMediatorContext,
  states: {
    idle: {
      on: {
        CONFLICT_DETECTED: {
          target: "detecting",
          actions: { type: "recordDetection" },
        },
      },
    },
    detecting: {
      on: {
        CONFLICT_CLASSIFIED: {
          target: "conflicted",
          actions: { type: "recordClassification" },
        },
      },
    },
    conflicted: {
      on: {
        MEDIATION_STARTED: { target: "resolving" },
        MEDIATION_ABORTED: {
          target: "aborted",
          actions: { type: "markAborted" },
        },
      },
    },
    resolving: {
      on: {
        RESOLUTION_OBSERVED: {
          target: "resolving",
          actions: { type: "recordResolution" },
        },
        RECONCILE_CONTINUE_REQUESTED: {
          target: "continuing",
          actions: { type: "recordContinueRequest" },
        },
        MEDIATION_ABORTED: {
          target: "aborted",
          actions: { type: "markAborted" },
        },
      },
    },
    continuing: {
      on: {
        // The replayed `git rebase --continue` surfaced the next patch's
        // conflicts — loop back through detection.
        CONFLICT_DETECTED: {
          target: "detecting",
          actions: { type: "recordDetection" },
        },
        RECONCILE_COMPLETED: { target: "resolved" },
        MEDIATION_ABORTED: {
          target: "aborted",
          actions: { type: "markAborted" },
        },
      },
    },
    resolved: {
      on: {
        RESTAGE_REQUESTED: {
          target: "reconciled",
          actions: { type: "markRestaged" },
        },
      },
    },
    reconciled: {
      type: "final",
    },
    aborted: {
      type: "final",
    },
  },
});

export type MediatorMachine = typeof mediatorMachine;
