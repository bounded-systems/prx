// GH-1768 — provenance demo: `derive why` over a seeded fixture.
// Captures the positive-signal #3 ("explainable derivations") from the
// issue's exit-criteria checklist.

import { describe, expect, test } from "bun:test";

import { projectAndRun, queryWhy } from "../../src/derive/index.ts";
import { fact, formatDerivationTree } from "../../src/derive/engine.ts";
import { makeRawState } from "./fixtures.ts";

describe("provenance — explain", () => {
  test("ready/GH-1768 has a derivation tree rooted in EDB facts", () => {
    const { view } = projectAndRun({
      rawStates: [makeRawState({ unitId: "GH-1768" })],
      beads: [{ id: "GH-1768", open: true, closed: false, blockedBy: [] }],
    });
    const tree = queryWhy(view, fact("ready", "GH-1768"));
    expect(tree).not.toBeNull();
    // The textual render is the demo deliverable; assert it mentions
    // both the rule and the issue id.
    const rendered = formatDerivationTree(tree!);
    expect(rendered).toContain("ready");
    expect(rendered).toContain("GH-1768");
    expect(rendered).toContain("[ready]");
    expect(rendered).toContain("[<edb>]");
  });

  test("explain returns null for a fact that is not derived", () => {
    const { view } = projectAndRun({
      rawStates: [makeRawState({ unitId: "GH-1" })],
      beads: [{ id: "GH-1", open: false, closed: true, blockedBy: [] }],
    });
    const tree = queryWhy(view, fact("ready", "GH-1"));
    expect(tree).toBeNull();
  });

  test("drift derivation cites the I-code", () => {
    const { view } = projectAndRun({
      rawStates: [
        makeRawState({
          prExists: true,
          prState: "open",
          prHeadRef: "A",
          branchName: "B",
          branchExistsLocal: true,
        }),
      ],
    });
    const tree = queryWhy(view, fact("drift", "GH-1768", "I02"));
    expect(tree).not.toBeNull();
    expect(tree!.rule).toContain("drift_i02");
  });
});
