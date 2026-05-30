// GH-1516: the planner-side preflight applies STOP_VERB_TOKENS as a layered
// defense above @bounded-systems/policy's isKnownSubcommand. The defense is only meaningful
// if no policy table / blocked entry has an English preposition or copula in
// its subcommand list — otherwise the deny-list and allowlist contradict and
// the GH-1514 regression class (e.g. `bd as` from "names bd as canonical")
// could re-emerge. This contract spans plan ↔ @bounded-systems/policy, so it lives here
// rather than inside the policy package's own (dependency-free) test.
import { describe, expect, test } from "bun:test";

import { isKnownSubcommand, type PolicyTool } from "@bounded-systems/policy";

import { STOP_VERB_TOKENS } from "../../src/plan/preflight_extract.ts";

describe("GH-1516: @bounded-systems/policy subcommand vocabulary is disjoint from STOP_VERB_TOKENS", () => {
  const TOOLS: PolicyTool[] = ["git", "gh", "wt", "bd", "prx"];
  for (const tool of TOOLS) {
    test(`${tool}: known-subcommand set is disjoint from STOP_VERB_TOKENS`, () => {
      const offenders = [...STOP_VERB_TOKENS].filter((token) =>
        isKnownSubcommand(tool, token),
      );
      expect(offenders).toEqual([]);
    });
  }
});
