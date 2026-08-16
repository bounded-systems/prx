import { describe, expect, test } from "bun:test";

import {
  ALL_CAPABILITIES,
  Capability,
  RequiredCapabilities,
  callerHoldsCapabilities,
  missingCapabilities,
} from "../../src/machine/capabilities.ts";

// ai-home-mqlno — the verb-level capability contract. The motivating case:
// author may dispatch the forge but must NOT reach `merge`. Conforming the
// dispatch gate to consult these is the later runtime slice.

describe("Capability", () => {
  test("enumerates the authority classes", () => {
    expect(new Set(ALL_CAPABILITIES)).toEqual(
      new Set(["pr-write", "merge", "git-write", "bd-write", "publish"]),
    );
    expect(Capability.safeParse("merge").success).toBe(true);
    expect(Capability.safeParse("delete-the-repo").success).toBe(false);
  });

  test("RequiredCapabilities defaults to none", () => {
    expect(RequiredCapabilities.parse(undefined)).toEqual([]);
  });
});

describe("callerHoldsCapabilities — the verb-level gate", () => {
  test("admits when the caller holds every required cap", () => {
    expect(callerHoldsCapabilities(["pr-write"], ["pr-write", "git-write"])).toBe(true);
    expect(callerHoldsCapabilities([], ["pr-write"])).toBe(true); // no requirement
  });

  test("the author→publisher-merge case: author holds pr-write, not merge → denied", () => {
    const authorGrants: Capability[] = ["pr-write"];
    // pr open/comment/edit/ready require pr-write — allowed.
    expect(callerHoldsCapabilities(["pr-write"], authorGrants)).toBe(true);
    // publisher merge requires `merge` — author lacks it → denied even though
    // the actor-level allowedCallers admits author to publisher.
    expect(callerHoldsCapabilities(["merge"], authorGrants)).toBe(false);
    expect(missingCapabilities(["merge"], authorGrants)).toEqual(["merge"]);
  });

  test("missingCapabilities reports exactly the unheld required caps", () => {
    expect(missingCapabilities(["pr-write", "merge"], ["pr-write"])).toEqual(["merge"]);
    expect(missingCapabilities(["pr-write"], ["pr-write"])).toEqual([]);
  });
});
