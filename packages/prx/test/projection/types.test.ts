import { describe, expect, test } from "bun:test";
import {
  blockedReason,
  isValidActionOk,
  projectionPhases,
  type Phase,
  type PrxProjection,
  type SessionLayout,
  type TransitionEvent,
  type ValidAction,
  type WorkUnit,
  type WorkUnitId,
} from "../../src/projection/index.ts";

describe("projection wire protocol", () => {
  test("projectionPhases enumerates every Phase in the spec", () => {
    expect(projectionPhases).toEqual([
      "triaged",
      "in_progress",
      "pr_open",
      "waiting_on_ci",
      "waiting_on_review",
      "ready_to_merge",
      "merged",
      "closed",
    ]);
  });

  test("WorkUnitId template literal accepts GH-<number>", () => {
    const id: WorkUnitId = "GH-730" as WorkUnitId;
    expect(id as string).toBe("GH-730");
  });

  test("WorkUnit carries full projection slice for the active unit", () => {
    const unit: WorkUnit = {
      id: "GH-730" as WorkUnitId,
      title: "Define prx↔UI wire protocol",
      phase: "in_progress",
      branch: "GH-730",
      pr: null,
      ci: null,
      worktree: { path: "/tmp/gh_730", detached: false },
    };
    expect(unit.id as string).toBe("GH-730");
    expect(unit.phase satisfies Phase).toBe("in_progress");
  });

  test("TransitionEvent records unit-phase transitions with cause", () => {
    const event: TransitionEvent = {
      at: "2026-04-22T12:00:00Z",
      unit: "GH-730" as WorkUnitId,
      from: "triaged",
      to: "in_progress",
      cause: "user",
    };
    expect(event.unit as string).toBe("GH-730");
    expect(event.cause).toBe("user");
  });

  test("PrxProjection groups active unit, timeline, actions, and board", () => {
    const projection: PrxProjection = {
      active: null,
      timeline: [],
      actions: [],
      board: [{ phase: "triaged", units: ["GH-730" as WorkUnitId] }],
    };
    expect(projection.board[0]?.units).toEqual(["GH-730" as WorkUnitId]);
  });

  test("isValidActionOk distinguishes ok from blocked guards", () => {
    const ok: ValidAction = {
      event: "transition.review",
      label: "Ready for review",
      command: "prx transition review",
      guard: "ok",
    };
    const blocked: ValidAction = {
      event: "transition.merge",
      label: "Merge",
      command: "prx transition merge",
      guard: { blocked: "ci pending" },
    };
    expect(isValidActionOk(ok)).toBe(true);
    expect(isValidActionOk(blocked)).toBe(false);
    expect(blockedReason(ok)).toBeNull();
    expect(blockedReason(blocked)).toBe("ci pending");
  });

  test("SessionLayout pins a fixed 2-tuple of dash + agent panes", () => {
    const layout: SessionLayout = {
      sessionName: "GH-730",
      panes: [
        { kind: "dash", cmd: "prx dash" },
        { kind: "agent", cmd: "claude" },
      ],
      split: "horizontal",
    };
    expect(layout.panes).toHaveLength(2);
    expect(layout.panes[0].kind).toBe("dash");
    expect(layout.panes[1].kind).toBe("agent");
  });
});
