/**
 * SPIKE — Layer-2 `fleet`: kick off and supervise many pilots; the agents view.
 *
 * The fleet is NOT a subagent (subagents can't nest) — it is the SDK host loop,
 * an XState machine that spawns one `pilot` actor per work unit, bounded by a
 * WIP cap, and projects each pilot's live snapshot into `context.board`. That
 * board IS the agents view: which unit is in which leg, signed-link count, and
 * whether it halted at `merged` / `abandoned`.
 *
 * The fleet is itself a SIGNING actor: as each pilot finishes it hands up its
 * in-toto summary statement; on drain the fleet mints a BATCH statement
 * (prx.fleet/v1) naming those summaries by digest — the top of the provenance
 * tree (fleet → pilots → legs). See provenance.ts.
 *
 * `prx --repo` is the fleet's input axis: feed it the unit list from a given
 * repo's `prx next` (or fan across repos).
 */

import {
  assign,
  createActor,
  fromCallback,
  fromPromise,
  setup,
  type AnyStateMachine,
} from "xstate";

import type { PilotContext, PilotOutput } from "./pilot.ts";
import {
  buildStatement,
  digestOf,
  stubStatementSigner,
  type Statement,
  type StatementSigner,
} from "./provenance.ts";

export type PilotFactory = (unitId: string) => AnyStateMachine;

export type FleetInput = {
  units: string[];
  /** Max pilots in flight at once. Default 4. */
  wip?: number;
};

export type FleetOpts = {
  /** Signs the fleet batch statement with the fleet's authority. */
  signBatch?: StatementSigner;
};

export type BoardEntry = {
  state: string;
  chainLength: number;
  status: "running" | "halted";
};

export type FleetContext = {
  units: string[];
  board: Record<string, BoardEntry>;
  /** Each finished pilot's in-toto summary, keyed for the batch statement. */
  summaries: Array<{ unitId: string; summary: Statement | null }>;
  /** The fleet's own in-toto artifact, minted on drain. */
  batch?: Statement;
  wip: number;
};

export type FleetOutput = {
  board: Record<string, BoardEntry>;
  batch: Statement | null;
};

type BoardEvent =
  | { type: "PILOT_PROGRESS"; unitId: string; state: string; chainLength: number }
  | {
      type: "PILOT_HALTED";
      unitId: string;
      state: string;
      chainLength: number;
      summary: Statement | null;
    }
  | { type: "FLEET_DRAINED" };

const DEFAULT_WIP = 4;

/**
 * Build the fleet machine. `makePilot` returns pilots bound to the production
 * `LegRunner` (real agents + signing) or to `stubLegRunner` for tests; the
 * fleet code is identical. `opts.signBatch` supplies the fleet's authority.
 */
export function createFleetMachine(makePilot: PilotFactory, opts: FleetOpts = {}) {
  const signBatch = opts.signBatch ?? stubStatementSigner("fleet");

  const supervisor = fromCallback<BoardEvent, { units: string[]; wip: number }>(
    ({ sendBack, input }) => {
      const pending = [...input.units];
      const live = new Set<ReturnType<typeof createActor>>();
      let running = 0;
      let stopped = false;

      const drainedIfIdle = () => {
        if (!stopped && running === 0 && pending.length === 0) {
          sendBack({ type: "FLEET_DRAINED" });
        }
      };

      const pump = () => {
        while (!stopped && running < input.wip && pending.length > 0) {
          const unitId = pending.shift() as string;
          running += 1;
          const actor = createActor(makePilot(unitId), { input: { workUnitId: unitId } });
          live.add(actor);
          actor.subscribe({
            next: (snap) => {
              const chainLength = (snap.context as PilotContext)?.chain?.length ?? 0;
              const state = String(snap.value);
              if (snap.status === "done") {
                const out = snap.output as PilotOutput | undefined;
                sendBack({
                  type: "PILOT_HALTED",
                  unitId,
                  state,
                  chainLength,
                  summary: out?.summary ?? null,
                });
              } else {
                sendBack({ type: "PILOT_PROGRESS", unitId, state, chainLength });
              }
            },
            complete: () => {
              running -= 1;
              live.delete(actor);
              pump();
              drainedIfIdle();
            },
          });
          actor.start();
        }
      };

      pump();
      drainedIfIdle();
      return () => {
        stopped = true;
        for (const actor of live) actor.stop();
      };
    },
  );

  // Mints the fleet's in-toto artifact over the collected pilot summaries.
  const sealBatch = fromPromise<Statement, { summaries: FleetContext["summaries"] }>(({ input }) =>
    buildStatement(signBatch, {
      predicateType: "prx.fleet/v1",
      subject: input.summaries.map((s) => ({
        name: s.unitId,
        digest: { sha256: s.summary ? digestOf(s.summary) : digestOf(null) },
      })),
      predicate: {
        unitCount: input.summaries.length,
        units: input.summaries.map((s) => ({
          unitId: s.unitId,
          signedBy: s.summary?.signedBy ?? null,
          summaryDigest: s.summary ? digestOf(s.summary) : null,
        })),
      },
    }),
  );

  return setup({
    types: {
      context: {} as FleetContext,
      input: {} as FleetInput,
      output: {} as FleetOutput,
      events: {} as BoardEvent,
    },
    actors: { supervisor, sealBatch },
    actions: {
      mark: assign({
        board: ({ context, event }, params: { status: BoardEntry["status"] }) => {
          if (event.type !== "PILOT_PROGRESS" && event.type !== "PILOT_HALTED")
            return context.board;
          return {
            ...context.board,
            [event.unitId]: {
              state: event.state,
              chainLength: event.chainLength,
              status: params.status,
            },
          };
        },
      }),
      collect: assign({
        summaries: ({ context, event }) => {
          if (event.type !== "PILOT_HALTED") return context.summaries;
          return [...context.summaries, { unitId: event.unitId, summary: event.summary }];
        },
      }),
      setBatch: assign({
        batch: ({ event }) => (event as unknown as { output: Statement }).output,
      }),
    },
  }).createMachine({
    id: "fleet",
    context: ({ input }) => ({
      units: [...input.units],
      board: {},
      summaries: [],
      wip: input.wip ?? DEFAULT_WIP,
    }),
    output: ({ context }) => ({ board: context.board, batch: context.batch ?? null }),
    initial: "running",
    states: {
      running: {
        invoke: {
          src: "supervisor",
          input: ({ context }) => ({ units: context.units, wip: context.wip }),
        },
        on: {
          PILOT_PROGRESS: { actions: { type: "mark", params: { status: "running" } } },
          PILOT_HALTED: {
            actions: [{ type: "mark", params: { status: "halted" } }, { type: "collect" }],
          },
          FLEET_DRAINED: "sealing",
        },
      },
      // Fleet-level signing: mint the batch statement over the pilot summaries.
      sealing: {
        invoke: {
          src: "sealBatch",
          input: ({ context }) => ({ summaries: context.summaries }),
          onDone: { target: "drained", actions: { type: "setBatch" } },
          onError: "drained",
        },
      },
      drained: { type: "final" },
    },
  });
}
