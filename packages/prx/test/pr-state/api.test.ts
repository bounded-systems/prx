import { describe, expect, test } from "bun:test";

import { getPrxSnapshot, type PrxApiContext } from "../../src/pr-state/api.ts";
import type { UnitOfWorkSurface } from "../../src/pr-state/uow.ts";

function makeContext(overrides: Partial<PrxApiContext> = {}): PrxApiContext {
  return {
    repoPath: "/repo",
    ticketPath: ".pr/local/tickets.json",
    workUnitId: "GH-5195",
    agentId: "GH-5195",
    mode: "full",
    ioFormat: "json",
    controlState: "idle",
    result: null,
    lastError: null,
    ...overrides,
  };
}

function makeSurface(overrides: Partial<UnitOfWorkSurface> = {}): UnitOfWorkSurface {
  return {
    repo: "owner/repo",
    remoteFreshness: "fresh",
    rows: [
      {
        id: "GH-5195",
        branch: "GH-5195",
        board: "committing",
        prNumber: null,
        worktree: true,
        agent: {
          id: "GH-5195",
          state: "idle",
        },
        ticket: null,
      },
    ],
    orphans: {
      ticketOnly: [],
      executionOnly: ["GH-5195"],
    },
    ...overrides,
  };
}

describe("prx api snapshot", () => {
  test("reports runnable canonical work units", () => {
    const snapshot = getPrxSnapshot(makeContext(), () => makeSurface());

    expect(snapshot.canRun).toBe(true);
    expect(snapshot.runBlockers).toEqual([]);
    expect(snapshot.unitState).toBe("committing");
    expect(snapshot.agentState).toBe("idle");
  });

  test("rejects when no canonical work unit is selected", () => {
    const snapshot = getPrxSnapshot(
      makeContext({ workUnitId: "<WORK-UNIT-ID>", agentId: "<WORK-UNIT-ID>" }),
      () => makeSurface({ rows: [] }),
    );

    expect(snapshot.canRun).toBe(false);
    expect(snapshot.runBlockers).toContain("no canonical work unit selected");
  });

  test("rejects when selected unit does not exist in the surface", () => {
    const snapshot = getPrxSnapshot(
      makeContext({ workUnitId: "GH-6000", agentId: "GH-6000" }),
      () => makeSurface(),
    );

    expect(snapshot.canRun).toBe(false);
    expect(snapshot.runBlockers).toContain("no unit of work found for GH-6000");
    expect(snapshot.unitState).toBe("unmapped");
  });

  test("reflects running control state in the active agent projection", () => {
    const snapshot = getPrxSnapshot(makeContext({ controlState: "dispatching" }), () =>
      makeSurface({
        rows: [
          {
            id: "GH-5195",
            branch: "GH-5195",
            board: "committing",
            prNumber: null,
            worktree: true,
            agent: {
              id: "GH-5195",
              state: "running",
            },
            ticket: null,
          },
        ],
      }),
    );

    expect(snapshot.agentState).toBe("running");
  });
});
