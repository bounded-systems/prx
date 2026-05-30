// XState v5 per-pair machine for one pinned `(uow, domain)` reconcile
// (GH-1537 — the GH-1500 authority ADR §3a periodic sync job).
//
// Lifecycle: idle → pulling → pushing → done | failed, with a `push_deferred`
// terminal branch off `pulling` for the GH-2095 split-orchestrator pull-only
// phase. Each invoke wraps a Zod-typed `fromPromise` actor in
// src/sync/actors.ts; tests swap actors via `domainSyncMachine.provide({
// actors })` rather than mocking modules. The run loop (src/sync/run.ts)
// spawns one instance per pinned pair per phase and awaits the final state —
// modelled structurally on `depResearchMachine`
// (src/dep-research/machine.ts).
//
// GH-2095: the run-loop runs pull over every pinned pair (unbounded by
// `--limit`) by spawning with `pushAllowed: false` — that path lands in
// `push_deferred` after `pulling`, leaving the close-apply step free to
// reach every closed-on-GH pair. A subsequent push phase respawns the
// machine for the first `limit` pairs with `prefilledPullResult` set, which
// triggers the `idle → pushing` short-circuit branch (re-using the cached
// pull result instead of re-fetching).
//
// DOMAIN_SYNC_* events are emitted on entry to each downstream state so
// observers (audit log, future TUI) track per-pair progress without depending
// on the actor result types. The run-loop-level events
// (DOMAIN_SYNC_BUDGET_PAUSED, DOMAIN_SYNC_TICK_COMPLETED — see
// src/machine/actors.ts) are emitted by the routine, not this per-pair machine.

import { assign, emit, setup } from "xstate";

import type { DomainAdapter } from "../adapters/domain-adapter.ts";
import type { BeadsRecord } from "../triage/triage.ts";
import { pullActor, pushActor } from "./actors.ts";
import type {
  DomainSyncPullResult,
  DomainSyncPushResult,
} from "./schemas.ts";

// ── machine input + context ────────────────────────────────────────────────

export type DomainSyncPairInput = {
  /** The pinned bd record (already validated by `loadAllBeads`). */
  bead: BeadsRecord;
  /** Domain prefix, e.g. `"gh"`. */
  domain: string;
  /** The external id the adapter exchanges — for `gh` the issue URL. */
  externalId: string;
  /** When true, the push leg plans but does not edit the external record. */
  dryRun: boolean;
  /**
   * Optional adapter override. Defaults to `adapterForDomain(domain)` inside
   * each actor; the seam keeps the GitHub adapter swappable in tests without
   * module mocks.
   */
  adapter?: DomainAdapter | undefined;
  /**
   * GH-2095 — when `false`, the machine lands in `push_deferred` after a
   * successful `pulling`, leaving the push leg as a no-op (the run loop's
   * pull-only phase uses this so close-apply sees every pinned pair while
   * `--limit` continues to cap the write-side push). Defaults to `true`
   * (the legacy idle → pulling → pushing → done lifecycle).
   */
  pushAllowed?: boolean | undefined;
  /**
   * GH-2095 — when set, the machine skips `pulling` and starts directly at
   * `pushing` with this result already in context (the run loop's push
   * phase re-uses the cached result from the prior pull-only phase instead
   * of re-fetching). Implies `pushAllowed: true` at the caller.
   */
  prefilledPullResult?: DomainSyncPullResult | null;
};

export type DomainSyncBlockedReason = {
  /** Name of the actor whose invoke rejected. */
  actor: string;
  /** Original rejection message. */
  message: string;
};

export type DomainSyncPairContext = {
  bead: BeadsRecord;
  domain: string;
  externalId: string;
  dryRun: boolean;
  adapter: DomainAdapter | undefined;
  pullResult: DomainSyncPullResult | null;
  pushResult: DomainSyncPushResult | null;
  blockedReason: DomainSyncBlockedReason | null;
  /** GH-2095 — false routes `pulling.onDone` to `push_deferred`. */
  pushAllowed: boolean;
};

export const initialDomainSyncPairContext = (
  input: DomainSyncPairInput,
): DomainSyncPairContext => ({
  bead: input.bead,
  domain: input.domain,
  externalId: input.externalId,
  dryRun: input.dryRun,
  adapter: input.adapter,
  pullResult: input.prefilledPullResult ?? null,
  pushResult: null,
  blockedReason: null,
  pushAllowed: input.pushAllowed ?? true,
});

export function domainSyncBlockedReason(
  actor: string,
  error: unknown,
): DomainSyncBlockedReason {
  const message = error instanceof Error ? error.message : String(error);
  return { actor, message };
}

// ── emitted events ─────────────────────────────────────────────────────────

export type DomainSyncEmittedEvent =
  | { type: "DOMAIN_SYNC_PAIR_STARTED" }
  | { type: "DOMAIN_SYNC_PULLED" }
  | { type: "DOMAIN_SYNC_PUSHED" }
  | { type: "DOMAIN_SYNC_PAIR_PUSH_DEFERRED" }
  | { type: "DOMAIN_SYNC_PAIR_DONE" }
  | { type: "DOMAIN_SYNC_PAIR_FAILED" };

// ── machine ────────────────────────────────────────────────────────────────

export const domainSyncMachine = setup({
  types: {
    context: {} as DomainSyncPairContext,
    input: {} as DomainSyncPairInput,
    emitted: {} as DomainSyncEmittedEvent,
  },
  actors: {
    pullActor,
    pushActor,
  },
}).createMachine({
  id: "domain_sync",
  initial: "idle",
  context: ({ input }) => initialDomainSyncPairContext(input),
  states: {
    // Documentary entry state. Emits DOMAIN_SYNC_PAIR_STARTED then branches:
    //   - prefilled pullResult ⇒ skip pulling, go straight to pushing (push
    //     phase of the GH-2095 split orchestrator).
    //   - otherwise ⇒ pulling (the standard pull-then-push lifecycle).
    idle: {
      entry: emit({ type: "DOMAIN_SYNC_PAIR_STARTED" }),
      always: [
        {
          target: "pushing",
          guard: ({ context }) =>
            context.pullResult !== null && context.pushAllowed,
        },
        { target: "pulling" },
      ],
    },
    pulling: {
      invoke: {
        id: "pull",
        src: "pullActor",
        input: ({ context }) => ({
          beadId: context.bead.id,
          domain: context.domain,
          externalId: context.externalId,
          beadStatus: context.bead.status,
          adapter: context.adapter,
        }),
        onDone: [
          {
            target: "pushing",
            guard: ({ context }) => context.pushAllowed,
            actions: [
              assign({ pullResult: ({ event }) => event.output }),
              emit({ type: "DOMAIN_SYNC_PULLED" }),
            ],
          },
          {
            target: "push_deferred",
            actions: [
              assign({ pullResult: ({ event }) => event.output }),
              emit({ type: "DOMAIN_SYNC_PULLED" }),
            ],
          },
        ],
        onError: {
          target: "failed",
          actions: assign({
            blockedReason: ({ event }) =>
              domainSyncBlockedReason("pull", event.error),
          }),
        },
      },
    },
    pushing: {
      invoke: {
        id: "push",
        src: "pushActor",
        input: ({ context }) => ({
          bead: context.bead,
          domain: context.domain,
          externalId: context.externalId,
          dryRun: context.dryRun,
          adapter: context.adapter,
        }),
        onDone: {
          target: "done",
          actions: assign({ pushResult: ({ event }) => event.output }),
        },
        onError: {
          target: "failed",
          actions: assign({
            blockedReason: ({ event }) =>
              domainSyncBlockedReason("push", event.error),
          }),
        },
      },
    },
    done: {
      type: "final",
      entry: [
        emit({ type: "DOMAIN_SYNC_PUSHED" }),
        emit({ type: "DOMAIN_SYNC_PAIR_DONE" }),
      ],
    },
    push_deferred: {
      type: "final",
      entry: emit({ type: "DOMAIN_SYNC_PAIR_PUSH_DEFERRED" }),
    },
    failed: {
      type: "final",
      entry: emit({ type: "DOMAIN_SYNC_PAIR_FAILED" }),
    },
  },
});

export type DomainSyncMachine = typeof domainSyncMachine;
