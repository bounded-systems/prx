// XState v5 machine for the `prx map` actor (GH-2016 PR-1).
//
// Mirrors src/triage/machine.ts at a smaller scale: one verb per run, picked
// by the input `verb` discriminant. The shape stays parallel so adding new
// verbs (e.g. `prx map list`, `prx map bond`) is one new state + one new
// invoke, not a structural redesign.
//
// Lifecycle: idle → (creating | showing | nextProjecting | syncing) →
// completed | failed. Each invoke wraps a Zod-typed `fromPromise` actor
// (src/map/actors.ts). The `idle` initial state emits a documentary
// `MAP_*_STARTED`-style event via `entry: emit()` so observers (audit log,
// future TUI) can track progress without depending on actor result types.
//
// PR-1 ships `creating` and `showing` against real verbs; `nextProjecting`
// and `syncing` invoke the stub actors that reject with `MapStubError`. The
// PR-2 / PR-3 children of GH-2016 unstub each branch.

import { assign, emit, setup } from "xstate";

import { createActor, nextActor, showActor, syncActor, MapStubError } from "./actors.ts";
import type { MapCreateActorResult, MapCreateOptions } from "./create.ts";
import type { MapShowActorResult, MapShowOptions } from "./show.ts";
import type { MapNextActorResult, MapNextOptions } from "./next.ts";
import type { MapSyncActorResult, MapSyncOptions } from "./sync.ts";
import type { MapMachineEvent } from "./schemas/index.ts";

// ── machine input + context ────────────────────────────────────────────────

export type MapMachineInput =
  | { verb: "create"; options: MapCreateOptions }
  | { verb: "show"; options: MapShowOptions }
  | { verb: "next"; options: MapNextOptions }
  | { verb: "sync"; options: MapSyncOptions };

export type MapBlockedReason = {
  /** Name of the actor whose invoke rejected. */
  actor: string;
  /** Owning ticket from the rejecting `MapStubError`, when available. */
  ticket: string | null;
  /** Original rejection message. */
  message: string;
};

export type MapMachineContext = {
  input: MapMachineInput;
  createResult: MapCreateActorResult | null;
  showResult: MapShowActorResult | null;
  nextResult: MapNextActorResult | null;
  syncResult: MapSyncActorResult | null;
  blockedReason: MapBlockedReason | null;
};

export const initialMapMachineContext = (input: MapMachineInput): MapMachineContext => ({
  input,
  createResult: null,
  showResult: null,
  nextResult: null,
  syncResult: null,
  blockedReason: null,
});

export function blockedReasonFromError(actor: string, error: unknown): MapBlockedReason {
  if (error instanceof MapStubError) {
    return { actor, ticket: error.ticket, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { actor, ticket: null, message };
}

// ── emitted events ─────────────────────────────────────────────────────────

export type MapEmittedEvent = MapMachineEvent;

// ── machine ────────────────────────────────────────────────────────────────

export const mapMachine = setup({
  types: {
    context: {} as MapMachineContext,
    input: {} as MapMachineInput,
    emitted: {} as MapEmittedEvent,
  },
  actors: {
    createActor,
    showActor,
    nextActor,
    syncActor,
  },
  guards: {
    isCreate: ({ context }) => context.input.verb === "create",
    isShow: ({ context }) => context.input.verb === "show",
    isNext: ({ context }) => context.input.verb === "next",
    isSync: ({ context }) => context.input.verb === "sync",
  },
}).createMachine({
  id: "map",
  initial: "idle",
  context: ({ input }) => initialMapMachineContext(input),
  states: {
    idle: {
      always: [
        { target: "creating", guard: "isCreate" },
        { target: "showing", guard: "isShow" },
        { target: "nextProjecting", guard: "isNext" },
        { target: "syncing", guard: "isSync" },
      ],
    },
    creating: {
      invoke: {
        id: "create",
        src: "createActor",
        input: ({ context }) =>
          context.input.verb === "create"
            ? context.input.options
            : (() => {
                throw new Error("map machine: invariant — creating entered with non-create verb");
              })(),
        onDone: {
          target: "completed",
          actions: [
            assign({ createResult: ({ event }) => event.output }),
            emit(({ event }) => ({ type: "MAP_CREATED" as const, name: event.output.name })),
          ],
        },
        onError: {
          target: "failed",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("create", event.error),
          }),
        },
      },
    },
    showing: {
      invoke: {
        id: "show",
        src: "showActor",
        input: ({ context }) =>
          context.input.verb === "show"
            ? context.input.options
            : (() => {
                throw new Error("map machine: invariant — showing entered with non-show verb");
              })(),
        onDone: {
          target: "completed",
          actions: [
            assign({ showResult: ({ event }) => event.output }),
            emit(({ event }) => ({ type: "MAP_SHOWN" as const, name: event.output.record.name })),
          ],
        },
        onError: {
          target: "failed",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("show", event.error),
          }),
        },
      },
    },
    nextProjecting: {
      invoke: {
        id: "next",
        src: "nextActor",
        input: ({ context }) =>
          context.input.verb === "next"
            ? context.input.options
            : (() => {
                throw new Error(
                  "map machine: invariant — nextProjecting entered with non-next verb",
                );
              })(),
        onDone: {
          target: "completed",
          actions: [
            assign({ nextResult: ({ event }) => event.output }),
            emit(({ event }) => {
              const first = event.output.picks[0]?.mapName ?? null;
              return { type: "MAP_NEXT_PROJECTED" as const, name: first };
            }),
          ],
        },
        onError: {
          target: "failed",
          actions: assign({
            blockedReason: ({ event }) => blockedReasonFromError("next", event.error),
          }),
        },
      },
    },
    syncing: {
      entry: emit(({ context }) =>
        context.input.verb === "sync"
          ? { type: "MAP_SYNC_STARTED" as const, name: context.input.options.name }
          : { type: "MAP_SYNC_STARTED" as const, name: "<invariant violation>" },
      ),
      invoke: {
        id: "sync",
        src: "syncActor",
        input: ({ context }) =>
          context.input.verb === "sync"
            ? context.input.options
            : (() => {
                throw new Error("map machine: invariant — syncing entered with non-sync verb");
              })(),
        onDone: {
          target: "completed",
          actions: [
            assign({ syncResult: ({ event }) => event.output }),
            emit(({ event }) => ({
              type: "MAP_SYNC_COMPLETED" as const,
              name: event.output.name,
              edgesWritten: event.output.edgesWritten,
            })),
          ],
        },
        onError: {
          target: "failed",
          actions: [
            assign({
              blockedReason: ({ event }) => blockedReasonFromError("sync", event.error),
            }),
            emit(({ context, event }) => ({
              type: "MAP_SYNC_FAILED" as const,
              name: context.input.verb === "sync" ? context.input.options.name : "<unknown>",
              message: event.error instanceof Error ? event.error.message : String(event.error),
            })),
          ],
        },
      },
    },
    completed: {
      type: "final",
    },
    failed: {
      type: "final",
    },
  },
});

export type MapMachine = typeof mapMachine;
