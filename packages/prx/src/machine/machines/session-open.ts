/**
 * GH-2027 — `sessionOpenMachine` for `prx <actor> session`.
 *
 * State machine for the schema-bound session-open lifecycle. Routes
 * the six `prx <actor> session` verbs (`plan`, `implement`, `intake`,
 * `triage`, `submit`, `author`) through `workspace.reserve` →
 * `workspace.prepare` → `sessionEntryMachine` dispatch as states,
 * not ad hoc shell code in CLI handlers.
 *
 *     idle → naming → reserving → materializing → preparing
 *                  → dispatching → opened
 *                  └─ failed_naming
 *                             └─ failed_reserve
 *                                       └─ failed_materialize
 *                                                  └─ failed_prepare
 *                                                            └─ failed_dispatch
 *
 * The machine is **documentary** — side effects (`runReserve`,
 * `runPrepare`, `chdir`, profile build) live in the orchestrator
 * (`src/session/open.ts`) which sends events to this machine and
 * reads the final state value. Pattern: `fetchMachine`
 * (src/machine/machines/fetch.ts) — explicit guards/actions/context,
 * no invoked actors.
 *
 * Each event the orchestrator emits is also recorded through
 * `recordEvent()` against the corresponding `SESSION_OPEN_*` audit
 * row (I-SO3); the machine itself only records the projection.
 */

import { assign, setup } from "xstate";

import type {
  Lifecycle,
  PrepareOutput,
  ReserveOutput,
  WorkspaceId,
} from "../../workspace/schema.ts";
import type { SessionActor } from "../../session/schema.ts";
import type { RuntimeProfileProjection } from "../runtime_profiles.ts";

export type SessionOpenStage = "naming" | "reserve" | "materialize" | "prepare" | "dispatch";

export type SessionOpenContext = {
  actor?: SessionActor | undefined;
  workUnitId?: string | undefined;
  branch?: string | undefined;
  workspaceId?: WorkspaceId | undefined;
  worktreePath?: string | undefined;
  lifecycle?: Lifecycle | undefined;
  reservedStatus?: ReserveOutput["status"] | undefined;
  preparedStatus?: PrepareOutput["status"] | undefined;
  profile?: RuntimeProfileProjection | undefined;
  failedStage?: SessionOpenStage | undefined;
  error?: string | undefined;
};

export const initialSessionOpenContext: SessionOpenContext = {};

export type SessionOpenEvent =
  | {
      type: "SESSION_OPEN_REQUESTED";
      actor: SessionActor;
      workUnitId?: string | undefined;
    }
  | {
      type: "SESSION_OPEN_NAME_DERIVED";
      branch: string;
      lifecycle: Lifecycle;
    }
  | {
      type: "SESSION_OPEN_RESERVED";
      workspaceId: WorkspaceId;
      reservedStatus: ReserveOutput["status"];
    }
  | {
      type: "SESSION_OPEN_MATERIALIZED";
      worktreePath: string;
    }
  | {
      type: "SESSION_OPEN_PREPARED";
      preparedStatus: PrepareOutput["status"];
    }
  | {
      type: "SESSION_OPEN_DISPATCHED";
      profile: RuntimeProfileProjection;
    }
  | {
      type: "SESSION_OPEN_FAILED";
      stage: SessionOpenStage;
      error: string;
    };

export const sessionOpenMachine = setup({
  types: {
    context: {} as SessionOpenContext,
    events: {} as SessionOpenEvent,
  },
  guards: {
    failedAtNaming: ({ event }) => event.type === "SESSION_OPEN_FAILED" && event.stage === "naming",
    failedAtReserve: ({ event }) =>
      event.type === "SESSION_OPEN_FAILED" && event.stage === "reserve",
    failedAtMaterialize: ({ event }) =>
      event.type === "SESSION_OPEN_FAILED" && event.stage === "materialize",
    failedAtPrepare: ({ event }) =>
      event.type === "SESSION_OPEN_FAILED" && event.stage === "prepare",
    failedAtDispatch: ({ event }) =>
      event.type === "SESSION_OPEN_FAILED" && event.stage === "dispatch",
  },
  actions: {
    recordRequested: assign(({ event }) => {
      if (event.type !== "SESSION_OPEN_REQUESTED") return {};
      return {
        actor: event.actor,
        workUnitId: event.workUnitId,
      };
    }),
    recordNameDerived: assign(({ event }) => {
      if (event.type !== "SESSION_OPEN_NAME_DERIVED") return {};
      return {
        branch: event.branch,
        lifecycle: event.lifecycle,
      };
    }),
    recordReserved: assign(({ event }) => {
      if (event.type !== "SESSION_OPEN_RESERVED") return {};
      return {
        workspaceId: event.workspaceId,
        reservedStatus: event.reservedStatus,
      };
    }),
    recordMaterialized: assign(({ event }) => {
      if (event.type !== "SESSION_OPEN_MATERIALIZED") return {};
      return {
        worktreePath: event.worktreePath,
      };
    }),
    recordPrepared: assign(({ event }) => {
      if (event.type !== "SESSION_OPEN_PREPARED") return {};
      return {
        preparedStatus: event.preparedStatus,
      };
    }),
    recordDispatched: assign(({ event }) => {
      if (event.type !== "SESSION_OPEN_DISPATCHED") return {};
      return {
        profile: event.profile,
      };
    }),
    recordFailure: assign(({ event }) => {
      if (event.type !== "SESSION_OPEN_FAILED") return {};
      return {
        failedStage: event.stage,
        error: event.error,
      };
    }),
  },
}).createMachine({
  id: "sessionOpen",
  initial: "idle",
  context: initialSessionOpenContext,
  states: {
    idle: {
      on: {
        SESSION_OPEN_REQUESTED: {
          target: "naming",
          actions: { type: "recordRequested" },
        },
      },
    },
    naming: {
      on: {
        SESSION_OPEN_NAME_DERIVED: {
          target: "reserving",
          actions: { type: "recordNameDerived" },
        },
        SESSION_OPEN_FAILED: {
          target: "failed_naming",
          guard: { type: "failedAtNaming" },
          actions: { type: "recordFailure" },
        },
      },
    },
    reserving: {
      on: {
        SESSION_OPEN_RESERVED: {
          target: "materializing",
          actions: { type: "recordReserved" },
        },
        SESSION_OPEN_FAILED: {
          target: "failed_reserve",
          guard: { type: "failedAtReserve" },
          actions: { type: "recordFailure" },
        },
      },
    },
    materializing: {
      on: {
        SESSION_OPEN_MATERIALIZED: {
          target: "preparing",
          actions: { type: "recordMaterialized" },
        },
        SESSION_OPEN_FAILED: {
          target: "failed_materialize",
          guard: { type: "failedAtMaterialize" },
          actions: { type: "recordFailure" },
        },
      },
    },
    preparing: {
      on: {
        SESSION_OPEN_PREPARED: {
          target: "dispatching",
          actions: { type: "recordPrepared" },
        },
        SESSION_OPEN_FAILED: {
          target: "failed_prepare",
          guard: { type: "failedAtPrepare" },
          actions: { type: "recordFailure" },
        },
      },
    },
    dispatching: {
      on: {
        SESSION_OPEN_DISPATCHED: {
          target: "opened",
          actions: { type: "recordDispatched" },
        },
        SESSION_OPEN_FAILED: {
          target: "failed_dispatch",
          guard: { type: "failedAtDispatch" },
          actions: { type: "recordFailure" },
        },
      },
    },
    opened: { type: "final" },
    failed_naming: { type: "final" },
    failed_reserve: { type: "final" },
    failed_materialize: { type: "final" },
    failed_prepare: { type: "final" },
    failed_dispatch: { type: "final" },
  },
});

export type SessionOpenMachine = typeof sessionOpenMachine;
