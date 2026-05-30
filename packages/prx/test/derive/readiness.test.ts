// GH-1768 — readiness rule tests (mirrors I-BD1).

import { describe, expect, test } from "bun:test";

import { projectAndRun, queryReady } from "../../src/derive/index.ts";
import { makeRawState } from "./fixtures.ts";

describe("rules/readiness — I-BD1", () => {
  test("open issue with no blockers is ready", () => {
    const { view } = projectAndRun({
      rawStates: [makeRawState({ unitId: "GH-1" })],
      beads: [{ id: "GH-1", open: true, closed: false, blockedBy: [] }],
    });
    expect(queryReady(view).map((r) => r.issueId)).toEqual(["GH-1"]);
  });

  test("open issue blocked by another open issue is not ready", () => {
    const { view } = projectAndRun({
      rawStates: [
        makeRawState({ unitId: "GH-1" }),
        makeRawState({ unitId: "GH-2" }),
      ],
      beads: [
        { id: "GH-1", open: true, closed: false, blockedBy: ["GH-2"] },
        { id: "GH-2", open: true, closed: false, blockedBy: [] },
      ],
    });
    expect(queryReady(view).map((r) => r.issueId).sort()).toEqual(["GH-2"]);
  });

  test("open issue blocked only by a closed issue is ready", () => {
    const { view } = projectAndRun({
      rawStates: [
        makeRawState({ unitId: "GH-1" }),
        makeRawState({ unitId: "GH-2" }),
      ],
      beads: [
        { id: "GH-1", open: true, closed: false, blockedBy: ["GH-2"] },
        { id: "GH-2", open: false, closed: true, blockedBy: [] },
      ],
    });
    expect(queryReady(view).map((r) => r.issueId).sort()).toEqual(["GH-1"]);
  });

  test("closed issue is never ready", () => {
    const { view } = projectAndRun({
      rawStates: [makeRawState({ unitId: "GH-1" })],
      beads: [{ id: "GH-1", open: false, closed: true, blockedBy: [] }],
    });
    expect(queryReady(view)).toEqual([]);
  });
});
