// GH-1659 — `repoRouterMachine` for the `repo_router` cross-repo routing
// actor. ADR: docs/spikes/GH-1646-cross-repo-bd-routing.md §5.
//
// State machine for the planning-tier cross-repo router. Mirrors the
// fetch lifecycle byte-for-byte so the parity chain has a uniform
// surface:
//
//   idle → resolving → materializing → routed → completed
//                                       ↓
//                                 failed_mid_route
//
// Events (parity-chain visible, names match ADR §5):
//
//   BD_PREFIX_DETECTED      — surface id parsed; long-id workspace prefix isolated
//   REPO_PIN_RESOLVED       — index lookup hit a foreign LocalRepo with that prefix
//   BARE_MATERIALIZED       — `prx repo materialize <name>` returned (clone/fetch/noop)
//   SESSION_RE_DISPATCHED   — caller re-issued OPEN_PLAN_SESSION against the bare
//   ROUTE_REFUSED_NO_PIN    — no index entry → terminate with structured hint
//   ROUTE_REFUSED_CONFLICT  — explicit --repo X disagrees with embedded prefix Y
//   ROUTE_FAILED            — materialize / re-dispatch threw → terminal failure
//
// Same discipline as `fetchMachine`: pure, no invoked actors, no I/O.
// The orchestrator (`src/repo_router/index.ts`) drives side effects and
// shells events here. Context is documentary, mirroring fetch's
// `pagesCommitted` / `lastSuccessfulUpdatedAt`.

import { assign, setup } from "xstate";

export type RepoRouterMaterializeAction = "cloned" | "fetched" | "noop";

export type RepoRouterContext = {
  surfaceId: string | null;
  prefix: string | null;
  repo: string | null;
  barePath: string | null;
  action: RepoRouterMaterializeAction | null;
  reason: string | null;
};

export const initialRepoRouterContext: RepoRouterContext = {
  surfaceId: null,
  prefix: null,
  repo: null,
  barePath: null,
  action: null,
  reason: null,
};

export type RepoRouterEvent =
  | { type: "BD_PREFIX_DETECTED"; surfaceId: string; prefix: string }
  | { type: "REPO_PIN_RESOLVED"; prefix: string; repo: string; barePath: string }
  | {
      type: "BARE_MATERIALIZED";
      repo: string;
      barePath: string;
      action: RepoRouterMaterializeAction;
    }
  | { type: "SESSION_RE_DISPATCHED"; surfaceId: string; repo: string; barePath: string }
  | { type: "ROUTE_REFUSED_NO_PIN"; surfaceId: string; prefix: string; hint: string }
  | {
      // GH-1661: refused at the gate when --repo X disagrees with the
      // embedded BD prefix that resolves to repo Y.
      type: "ROUTE_REFUSED_CONFLICT";
      surfaceId: string;
      requestedRepo: string;
      embeddedPrefix: string;
      embeddedRepo: string;
      hint: string;
    }
  | { type: "ROUTE_FAILED"; surfaceId: string; reason: string };

export const repoRouterMachine = setup({
  types: {
    context: {} as RepoRouterContext,
    events: {} as RepoRouterEvent,
  },
  actions: {
    recordPrefix: assign(({ event }) => {
      if (event.type !== "BD_PREFIX_DETECTED") return {};
      return { surfaceId: event.surfaceId, prefix: event.prefix };
    }),
    recordRepoPin: assign(({ event }) => {
      if (event.type !== "REPO_PIN_RESOLVED") return {};
      return {
        prefix: event.prefix,
        repo: event.repo,
        barePath: event.barePath,
      };
    }),
    recordMaterialize: assign(({ event }) => {
      if (event.type !== "BARE_MATERIALIZED") return {};
      return {
        repo: event.repo,
        barePath: event.barePath,
        action: event.action,
      };
    }),
    recordDispatch: assign(({ event }) => {
      if (event.type !== "SESSION_RE_DISPATCHED") return {};
      return {
        surfaceId: event.surfaceId,
        repo: event.repo,
        barePath: event.barePath,
      };
    }),
    recordRefusal: assign(({ event }) => {
      if (event.type !== "ROUTE_REFUSED_NO_PIN") return {};
      return {
        surfaceId: event.surfaceId,
        prefix: event.prefix,
        reason: event.hint,
      };
    }),
    recordConflict: assign(({ event }) => {
      if (event.type !== "ROUTE_REFUSED_CONFLICT") return {};
      return {
        surfaceId: event.surfaceId,
        prefix: event.embeddedPrefix,
        repo: event.embeddedRepo,
        reason: event.hint,
      };
    }),
    recordFailure: assign(({ event }) => {
      if (event.type !== "ROUTE_FAILED") return {};
      return { surfaceId: event.surfaceId, reason: event.reason };
    }),
  },
}).createMachine({
  id: "repoRouter",
  initial: "idle",
  context: initialRepoRouterContext,
  states: {
    idle: {
      on: {
        BD_PREFIX_DETECTED: {
          target: "resolving",
          actions: { type: "recordPrefix" },
        },
      },
    },
    resolving: {
      on: {
        REPO_PIN_RESOLVED: {
          target: "materializing",
          actions: { type: "recordRepoPin" },
        },
        ROUTE_REFUSED_NO_PIN: {
          target: "failed_mid_route",
          actions: { type: "recordRefusal" },
        },
        ROUTE_REFUSED_CONFLICT: {
          target: "failed_mid_route",
          actions: { type: "recordConflict" },
        },
      },
    },
    materializing: {
      on: {
        BARE_MATERIALIZED: {
          target: "routed",
          actions: { type: "recordMaterialize" },
        },
        ROUTE_FAILED: {
          target: "failed_mid_route",
          actions: { type: "recordFailure" },
        },
      },
    },
    routed: {
      on: {
        SESSION_RE_DISPATCHED: {
          target: "completed",
          actions: { type: "recordDispatch" },
        },
      },
    },
    completed: {
      type: "final",
    },
    failed_mid_route: {
      type: "final",
    },
  },
});

export type RepoRouterMachine = typeof repoRouterMachine;
