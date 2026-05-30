// GH-1603 — `fetchMachine` for `prx fetch gh-issues`.
//
// State machine for the native-GraphQL write path (see
// docs/fetch-spike-retro.md §Q3 for the transport decision that retired
// the dead shell-out probe). The spike's three "documentary" events
// (`FETCH_PLAN_COMPUTED`, `FETCH_WATERMARK_READ`, `FETCH_DRY_RUN_DECIDED`)
// stay; this PR adds six new events that drive real transitions:
//
//   FETCH_PAGE_FETCHED          — one graphql page response parsed cleanly
//   FETCH_PAGE_WRITTEN          — per-page bd write loop committed all rows
//   FETCH_PAGE_FAILED           — graphql page or bd write failed
//   FETCH_WATERMARK_ADVANCED    — setWatermark succeeded after a page write
//   FETCH_RUN_COMPLETED         — last page committed + no more pages
//   FETCH_RUN_FAILED_MID_FETCH  — aborted with ≥1 successful page committed
//
// I-F4 (page atomicity) and I-F5 (watermark monotonicity) live in
// `src/machine/state.ts`; the machine here is the documentary projection
// of the orchestrator's actual control flow. Pattern: `taskRoleMachine`
// (src/machine/machines/task.ts) — explicit guards/actions/context, no
// invoked actors.

import { assign, setup } from "xstate";

export type FetchDecision = "go" | "skip" | "fail";

export type FetchRunContext = {
  dryRun: boolean;
  decision: FetchDecision | null;
  pagesCommitted: number;
  totalPagesExpected: number | null;
  rowsWrittenTotal: number;
  pointsSpentTotal: number;
  lastSuccessfulUpdatedAt: string | null;
  hasMorePages: boolean;
};

export const initialFetchRunContext: FetchRunContext = {
  dryRun: false,
  decision: null,
  pagesCommitted: 0,
  totalPagesExpected: null,
  rowsWrittenTotal: 0,
  pointsSpentTotal: 0,
  lastSuccessfulUpdatedAt: null,
  hasMorePages: true,
};

export type FetchRunEvent =
  | {
      type: "FETCH_PLAN_COMPUTED";
      totalPagesExpected: number;
      dryRun: boolean;
    }
  | { type: "FETCH_WATERMARK_READ" }
  | { type: "FETCH_DRY_RUN_DECIDED"; decision: FetchDecision; dryRun: boolean }
  | {
      type: "FETCH_PAGE_FETCHED";
      pageNumber: number;
      pointsSpent: number;
      nodeCount: number;
    }
  | {
      type: "FETCH_PAGE_WRITTEN";
      pageNumber: number;
      rowsWritten: number;
      lastUpdatedAt: string;
    }
  | {
      type: "FETCH_PAGE_FAILED";
      pageNumber: number;
      code: string;
      lastSuccessfulUpdatedAt: string | null;
    }
  | {
      type: "FETCH_WATERMARK_ADVANCED";
      newSince: string;
      pageNumber: number;
      hasMorePages: boolean;
    }
  | {
      type: "FETCH_RUN_COMPLETED";
      totalPages: number;
      totalRowsWritten: number;
      totalPointsSpent: number;
    }
  | {
      type: "FETCH_RUN_FAILED_MID_FETCH";
      pagesCommitted: number;
      lastSuccessfulUpdatedAt: string | null;
      code: string;
    };

export const fetchMachine = setup({
  types: {
    context: {} as FetchRunContext,
    events: {} as FetchRunEvent,
  },
  guards: {
    decisionGo: ({ event }) =>
      event.type === "FETCH_DRY_RUN_DECIDED" &&
      event.decision === "go" &&
      !event.dryRun,
    dryRunOnly: ({ event }) =>
      event.type === "FETCH_DRY_RUN_DECIDED" &&
      (event.dryRun || event.decision === "skip"),
    decisionFail: ({ event }) =>
      event.type === "FETCH_DRY_RUN_DECIDED" && event.decision === "fail",
    hasMorePages: ({ event }) =>
      event.type === "FETCH_WATERMARK_ADVANCED" && event.hasMorePages,
    isLastPage: ({ event }) =>
      event.type === "FETCH_WATERMARK_ADVANCED" && !event.hasMorePages,
  },
  actions: {
    recordProjection: assign(({ event }) => {
      if (event.type !== "FETCH_PLAN_COMPUTED") return {};
      return {
        totalPagesExpected: event.totalPagesExpected,
        dryRun: event.dryRun,
      };
    }),
    recordDecision: assign(({ event }) => {
      if (event.type !== "FETCH_DRY_RUN_DECIDED") return {};
      return { decision: event.decision, dryRun: event.dryRun };
    }),
    recordPageFetched: assign(({ context, event }) => {
      if (event.type !== "FETCH_PAGE_FETCHED") return {};
      return {
        pointsSpentTotal: context.pointsSpentTotal + event.pointsSpent,
      };
    }),
    recordPageWritten: assign(({ context, event }) => {
      if (event.type !== "FETCH_PAGE_WRITTEN") return {};
      return {
        pagesCommitted: context.pagesCommitted + 1,
        rowsWrittenTotal: context.rowsWrittenTotal + event.rowsWritten,
        lastSuccessfulUpdatedAt: event.lastUpdatedAt,
      };
    }),
    recordWatermarkAdvanced: assign(({ event }) => {
      if (event.type !== "FETCH_WATERMARK_ADVANCED") return {};
      return {
        lastSuccessfulUpdatedAt: event.newSince,
        hasMorePages: event.hasMorePages,
      };
    }),
    recordPageFailed: assign(({ event }) => {
      if (event.type !== "FETCH_PAGE_FAILED") return {};
      return {
        lastSuccessfulUpdatedAt: event.lastSuccessfulUpdatedAt,
      };
    }),
  },
}).createMachine({
  id: "fetchSystem",
  initial: "idle",
  context: initialFetchRunContext,
  states: {
    idle: {
      on: {
        FETCH_PLAN_COMPUTED: {
          target: "projecting",
          actions: { type: "recordProjection" },
        },
      },
    },
    projecting: {
      on: {
        FETCH_DRY_RUN_DECIDED: [
          {
            target: "fetching",
            guard: { type: "decisionGo" },
            actions: { type: "recordDecision" },
          },
          {
            target: "completed",
            guard: { type: "dryRunOnly" },
            actions: { type: "recordDecision" },
          },
          {
            target: "failed_mid_fetch",
            guard: { type: "decisionFail" },
            actions: { type: "recordDecision" },
          },
        ],
      },
    },
    fetching: {
      on: {
        FETCH_PAGE_FETCHED: {
          target: "writing",
          actions: { type: "recordPageFetched" },
        },
        FETCH_PAGE_FAILED: {
          target: "failed_mid_fetch",
          actions: { type: "recordPageFailed" },
        },
      },
    },
    writing: {
      on: {
        FETCH_PAGE_WRITTEN: {
          target: "advancing",
          actions: { type: "recordPageWritten" },
        },
        FETCH_PAGE_FAILED: {
          target: "failed_mid_fetch",
          actions: { type: "recordPageFailed" },
        },
      },
    },
    advancing: {
      on: {
        FETCH_WATERMARK_ADVANCED: [
          {
            target: "fetching",
            guard: { type: "hasMorePages" },
            actions: { type: "recordWatermarkAdvanced" },
          },
          {
            target: "completed",
            guard: { type: "isLastPage" },
            actions: { type: "recordWatermarkAdvanced" },
          },
        ],
      },
    },
    completed: {
      type: "final",
    },
    failed_mid_fetch: {
      type: "final",
    },
  },
});

export type FetchMachine = typeof fetchMachine;
