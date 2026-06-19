// GH-1768 — oracle parity: `assertInvariants` (imperative) vs
// `queryDrift` (declarative). On every fixture the set of failing
// invariant codes must agree. A divergence is either a bug in the
// rules or a finding for the retro (e.g. arithmetic-only invariants
// like I06/I07 leaked into the projection sentinel — by design in
// v0, but documented).

import { describe, expect, test } from "bun:test";

import { assertInvariants, derivePhase, type RawStateV1 } from "@bounded-systems/machine-schema";
import { projectAndRun, queryDrift } from "../../src/derive/index.ts";
import { makeRawState } from "./fixtures.ts";

function findingsFor(raw: RawStateV1): string[] {
  const phase = derivePhase(raw);
  return assertInvariants(raw, phase)
    .findings.map((f) => f.id)
    .sort();
}

function driftFor(raw: RawStateV1): string[] {
  const { view } = projectAndRun({ rawStates: [raw] });
  return [...new Set(queryDrift(view).map((d) => d.code))].sort();
}

describe("oracle parity — assertInvariants vs queryDrift", () => {
  // Every fixture below exercises one of the I01/I02/I03/I06/I07/I08
  // findings the imperative oracle reports. I04 / I05 / I09 require
  // phase-bound preconditions; derivePhase makes those unreachable
  // through plain RawStateV1 mutations (you'd need a phase-inverted
  // fixture), so we skip them here and document the gap in the retro.
  const fixtures: Array<[string, RawStateV1]> = [
    [
      "clean",
      makeRawState({
        unitId: "GH-1",
        prExists: true,
        prState: "open",
        prHeadRef: "GH-1",
        prIsDraft: false,
        branchName: "GH-1",
        branchExistsLocal: true,
        branchExistsRemote: true,
        branchHeadShaLocal: "sha",
        branchHeadShaRemote: "sha",
        worktreeExists: true,
        worktreePath: "/tmp/wt",
        worktreeCheckedOutBranch: "GH-1",
        ciState: "passed",
        ciRequiredTotal: 1,
        ciRequiredPassed: 1,
        remoteFresh: true,
      }),
    ],
    [
      "I01-no-branch",
      makeRawState({
        prExists: true,
        prState: "open",
        prHeadRef: "X",
        branchName: "X",
        branchExistsLocal: false,
        branchExistsRemote: false,
      }),
    ],
    [
      "I02-headref-mismatch",
      makeRawState({
        prExists: true,
        prState: "open",
        prHeadRef: "A",
        branchName: "B",
        branchExistsLocal: true,
      }),
    ],
    [
      "I03-worktree-branch-mismatch",
      makeRawState({
        worktreeExists: true,
        worktreePath: "/x",
        worktreeCheckedOutBranch: "A",
        branchName: "B",
        branchExistsLocal: true,
      }),
    ],
    [
      "I06-overflow",
      makeRawState({
        ciState: "passed",
        ciRequiredTotal: 1,
        ciRequiredPassed: 5,
      }),
    ],
    [
      "I07-passed-but-incomplete",
      makeRawState({
        ciState: "passed",
        ciRequiredTotal: 5,
        ciRequiredPassed: 4,
      }),
    ],
    [
      "I08-sha-mismatch",
      makeRawState({
        branchName: "X",
        branchExistsLocal: true,
        branchExistsRemote: true,
        branchHeadShaLocal: "a",
        branchHeadShaRemote: "b",
        remoteFresh: true,
      }),
    ],
  ];

  for (const [name, raw] of fixtures) {
    test(`agrees on fixture: ${name}`, () => {
      const oracle = findingsFor(raw);
      const declarative = driftFor(raw);
      // Restrict comparison to the codes the spike actually encodes
      // (I01..I08, excluding I04/I05/I09 which the spike does not
      // cover in v0). Other findings are filtered out of the oracle
      // for the agreement check; the retro documents the coverage gap.
      const covered = new Set(["I01", "I02", "I03", "I06", "I07", "I08"]);
      const oracleCovered = oracle.filter((c) => covered.has(c));
      const declarativeCovered = declarative.filter((c) => covered.has(c));
      expect(declarativeCovered).toEqual(oracleCovered);
    });
  }
});
