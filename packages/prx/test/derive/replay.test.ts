// GH-1768 — replay determinism + monotonicity.

import { describe, expect, test } from "bun:test";

import { replay, checkMonotonicity } from "../../src/derive/replay.ts";
import type { ProjectInput } from "../../src/derive/project.ts";
import { makeRawState } from "./fixtures.ts";

describe("replay — determinism + monotonicity", () => {
  test("rerunning identical inputs yields identical fact lists", () => {
    const input: ProjectInput = {
      rawStates: [
        makeRawState({
          unitId: "GH-1",
          branchName: "GH-1",
          branchExistsLocal: true,
        }),
      ],
      beads: [{ id: "GH-1", open: true, closed: false, blockedBy: [] }],
    };
    const report = replay([input, input, input]);
    expect(report.deterministic).toBe(true);
    // All three steps must summarize identically (same input each
    // time, so the fact set never moves).
    expect(report.steps[0]?.facts).toEqual(report.steps[1]!.facts);
    expect(report.steps[1]?.facts).toEqual(report.steps[2]!.facts);
  });

  test("lifecycle growth is monotonic over branch+pr relations", () => {
    const step0: ProjectInput = {
      rawStates: [makeRawState({ unitId: "GH-1" })],
      beads: [{ id: "GH-1", open: true, closed: false, blockedBy: [] }],
    };
    const step1: ProjectInput = {
      rawStates: [
        makeRawState({
          unitId: "GH-1",
          worktreeExists: true,
          worktreePath: "/x",
          worktreeCheckedOutBranch: "GH-1",
          branchName: "GH-1",
          branchExistsLocal: true,
        }),
      ],
      beads: step0.beads,
    };
    const step2: ProjectInput = {
      rawStates: [
        makeRawState({
          unitId: "GH-1",
          worktreeExists: true,
          worktreePath: "/x",
          worktreeCheckedOutBranch: "GH-1",
          branchName: "GH-1",
          branchExistsLocal: true,
          branchExistsRemote: true,
          prExists: true,
          prState: "open",
          prHeadRef: "GH-1",
        }),
      ],
      beads: step0.beads,
    };
    // Issue + transition facts should grow monotonically.
    const findings = checkMonotonicity([step0, step1, step2], ["issue"]);
    expect(findings).toEqual([]);
  });
});
