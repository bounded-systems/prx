// Predicate-binding precursor: the per-member `binding` tag (event | property)
// and the bundle normalizer that lets the singular `requiredArtifact`/
// `requiredStatus` form and the explicit `requiredPredicates` form be read
// through one seam. This is type/schema-only — it changes no guard behaviour;
// the bundle-weighing verdict and footprint→gate mapping are queued follow-ups.

import { describe, expect, test } from "bun:test";

import {
  LEGACY_PREDICATE_BINDING,
  predicateBindings,
  requiredPredicateSchema,
  requiredPredicatesOf,
  transitionContractSchema,
  type TransitionContract,
} from "../../../src/machine/contracts.ts";
import { listTransitionContracts } from "../../../src/machine/contracts/transitions.ts";

const base = (over: Partial<TransitionContract> = {}): TransitionContract =>
  transitionContractSchema.parse({
    axis: "lifecycle",
    fromPhase: "map",
    toPhase: "delegate",
    requiredArtifact: "work_map",
    requiredStatus: "present",
    forbiddenArtifacts: [],
    guardId: "mapToDelegate.requireWorkMap",
    ...over,
  });

describe("predicate binding tag", () => {
  test("the two bindings are property and event", () => {
    expect([...predicateBindings]).toEqual(["property", "event"]);
  });

  test("requiredPredicateSchema accepts a well-formed member", () => {
    const p = requiredPredicateSchema.parse({
      artifact: "review_bundle",
      status: "passed",
      binding: "event",
    });
    expect(p.binding).toBe("event");
  });

  test("requiredPredicateSchema rejects an unknown binding", () => {
    expect(() =>
      requiredPredicateSchema.parse({
        artifact: "review_bundle",
        status: "passed",
        binding: "vibes",
      }),
    ).toThrow();
  });

  test("the legacy singular pair is treated as property-bound", () => {
    expect(LEGACY_PREDICATE_BINDING).toBe("property");
  });
});

describe("requiredPredicatesOf normalizer", () => {
  test("projects the singular form to a one-member property-bound bundle", () => {
    const bundle = requiredPredicatesOf(base());
    expect(bundle).toEqual([
      { artifact: "work_map", status: "present", binding: "property" },
    ]);
  });

  test("returns an explicit bundle verbatim when declared", () => {
    const contract = base({
      requiredPredicates: [
        { artifact: "test_run", status: "passed", binding: "property" },
        { artifact: "review_bundle", status: "passed", binding: "event" },
      ],
    });
    const bundle = requiredPredicatesOf(contract);
    expect(bundle).toHaveLength(2);
    expect(bundle.map((p) => p.binding)).toEqual(["property", "event"]);
  });
});

describe("backward compatibility", () => {
  test("requiredPredicates is optional — the four shipped contracts omit it", () => {
    for (const t of listTransitionContracts()) {
      expect(t.requiredPredicates).toBeUndefined();
      // every shipped contract still normalizes to exactly one property-bound
      // predicate, so guards reading the singular fields are unaffected.
      const bundle = requiredPredicatesOf(t);
      expect(bundle).toHaveLength(1);
      expect(bundle[0]!.binding).toBe("property");
      expect(bundle[0]!.artifact).toBe(t.requiredArtifact);
      expect(bundle[0]!.status).toBe(t.requiredStatus);
    }
  });

  test("the bundle form parses (forward-compatible authoring)", () => {
    const contract = base({
      requiredPredicates: [
        { artifact: "work_map", status: "present", binding: "property" },
      ],
    });
    expect(contract.requiredPredicates).toHaveLength(1);
  });
});
