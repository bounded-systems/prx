// GH-1397 — `handoffMachine` for the structured handoff queue.
//
// Pure XState machine owning the handoff lifecycle. The bd-memory row
// (src/handoff/store.ts) is the durable projection; the machine is the
// documentary lifecycle. bd I/O is injected via callbacks per the
// `defaultExecBd` pattern (src/memory/compact.ts:30) — the machine itself
// stays free of `bd` / `fs` dependencies.
//
// State graph (mirrors `handoffStatus` in @bounded-systems/machine-schema):
//
//   pending ──CLAIM────────────────────▶ claimed
//   claimed ──(claim TTL expired)─────▶ pending          (reclaim path)
//   claimed ──DRAIN_STARTED───────────▶ draining
//   draining ──DRAIN_SUCCEEDED────────▶ done             (terminal)
//   draining ──DRAIN_FAILED───────────▶ failed
//   failed ──RETRY (attempts<max)─────▶ pending          (re-enqueue)
//   failed ──(attempts ≥ max | ABAN)──▶ abandoned        (terminal)
//   pending ──(global TTL expired)────▶ abandoned        (terminal)
//
// Guards stay synchronous and pure: `notAlreadyClaimed` (CAS on
// `claimedBy`), `withinMaxAttempts`, `notExpired`. Recipient-specific
// `intentParses` checks execute inside the drainer adapter (not in the
// machine), keeping the machine independent of recipient Zods.

import { assign, setup } from "xstate";

import type {
  HandoffEnvelope,
  HandoffStatus,
} from "@bounded-systems/machine-schema";

// ── machine context ────────────────────────────────────────────────────────

export type HandoffMachineContext = {
  envelope: HandoffEnvelope;
  /** Effect-pending DRAIN_FAILED error string, surfaced into context.lastError. */
  pendingError: string | null;
};

export const makeInitialHandoffContext = (
  envelope: HandoffEnvelope,
): HandoffMachineContext => ({
  envelope,
  pendingError: null,
});

// ── events ─────────────────────────────────────────────────────────────────
//
// Every event carries a `now` ISO timestamp injected by the caller so the
// machine itself does not read the wall clock. This matches the existing
// pattern of pushing time-of-day decisions to the caller (audit inspector
// `opts.deps?.now`).

export type HandoffMachineEvent =
  | { type: "CLAIM"; claimant: string; claimTtlSec: number; now: string }
  | { type: "CLAIM_TTL_EXPIRED"; now: string }
  | { type: "DRAIN_STARTED"; now: string }
  | { type: "DRAIN_SUCCEEDED"; now: string }
  | { type: "DRAIN_FAILED"; error: string; now: string }
  | { type: "RETRY"; now: string }
  | { type: "ABANDON"; reason: string; now: string }
  | { type: "GLOBAL_TTL_EXPIRED"; now: string };

// ── machine ────────────────────────────────────────────────────────────────

export const handoffMachine = setup({
  types: {
    context: {} as HandoffMachineContext,
    events: {} as HandoffMachineEvent,
  },
  guards: {
    // I-HQ3 compare-and-swap: a second CLAIM on an already-claimed row is a
    // no-op. The store-side write (UPDATE ... WHERE claimedBy IS NULL) is
    // the durable enforcement; this guard catches the race at the machine
    // boundary so a duplicate claim never advances state.
    notAlreadyClaimed: ({ context }) => context.envelope.claimedBy === undefined,
    withinMaxAttempts: ({ context }) =>
      context.envelope.attempts + 1 < context.envelope.maxAttempts,
    atMaxAttempts: ({ context }) =>
      context.envelope.attempts + 1 >= context.envelope.maxAttempts,
  },
  actions: {
    recordClaim: assign(({ context, event }) => {
      if (event.type !== "CLAIM") return {};
      return {
        envelope: {
          ...context.envelope,
          status: "claimed" as HandoffStatus,
          claimedBy: event.claimant,
          claimAt: event.now,
          claimTtlSec: event.claimTtlSec,
        },
      };
    }),
    releaseClaim: assign(({ context }) => ({
      envelope: {
        ...context.envelope,
        status: "pending" as HandoffStatus,
        claimedBy: undefined,
        claimAt: undefined,
        claimTtlSec: undefined,
      },
    })),
    markDraining: assign(({ context }) => ({
      envelope: {
        ...context.envelope,
        status: "draining" as HandoffStatus,
      },
    })),
    markDone: assign(({ context }) => ({
      envelope: {
        ...context.envelope,
        status: "done" as HandoffStatus,
        claimedBy: undefined,
        claimAt: undefined,
        claimTtlSec: undefined,
      },
    })),
    markFailed: assign(({ context, event }) => {
      if (event.type !== "DRAIN_FAILED") return {};
      return {
        envelope: {
          ...context.envelope,
          status: "failed" as HandoffStatus,
          attempts: context.envelope.attempts + 1,
          lastError: event.error,
        },
        pendingError: event.error,
      };
    }),
    markAbandoned: assign(({ context, event }) => {
      const reason =
        event.type === "ABANDON"
          ? event.reason
          : event.type === "GLOBAL_TTL_EXPIRED"
            ? "global-ttl-expired"
            : (context.envelope.lastError ?? "max-attempts-exceeded");
      return {
        envelope: {
          ...context.envelope,
          status: "abandoned" as HandoffStatus,
          lastError: reason,
          claimedBy: undefined,
          claimAt: undefined,
          claimTtlSec: undefined,
        },
      };
    }),
    requeueForRetry: assign(({ context }) => ({
      envelope: {
        ...context.envelope,
        status: "pending" as HandoffStatus,
        claimedBy: undefined,
        claimAt: undefined,
        claimTtlSec: undefined,
      },
      pendingError: null,
    })),
  },
}).createMachine({
  id: "handoff",
  initial: "pending",
  context: ({ input }) => makeInitialHandoffContext(input as HandoffEnvelope),
  states: {
    pending: {
      on: {
        CLAIM: {
          target: "claimed",
          guard: { type: "notAlreadyClaimed" },
          actions: { type: "recordClaim" },
        },
        GLOBAL_TTL_EXPIRED: {
          target: "abandoned",
          actions: { type: "markAbandoned" },
        },
      },
    },
    claimed: {
      on: {
        DRAIN_STARTED: {
          target: "draining",
          actions: { type: "markDraining" },
        },
        // Reclaim path: a claim that times out without a DRAIN_STARTED rolls
        // back to pending so another claimant can pick it up. Mirrors the
        // bd-side store's TTL sweep.
        CLAIM_TTL_EXPIRED: {
          target: "pending",
          actions: { type: "releaseClaim" },
        },
      },
    },
    draining: {
      on: {
        DRAIN_SUCCEEDED: {
          target: "done",
          actions: { type: "markDone" },
        },
        DRAIN_FAILED: {
          target: "failed",
          actions: { type: "markFailed" },
        },
      },
    },
    failed: {
      on: {
        RETRY: [
          {
            target: "pending",
            guard: { type: "withinMaxAttempts" },
            actions: { type: "requeueForRetry" },
          },
          {
            target: "abandoned",
            guard: { type: "atMaxAttempts" },
            actions: { type: "markAbandoned" },
          },
        ],
        ABANDON: {
          target: "abandoned",
          actions: { type: "markAbandoned" },
        },
      },
    },
    done: {
      type: "final",
    },
    abandoned: {
      type: "final",
    },
  },
});

export type HandoffMachine = typeof handoffMachine;
