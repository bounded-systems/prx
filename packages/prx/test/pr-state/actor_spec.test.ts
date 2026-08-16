// GH-1530 — ActorSpec registry (object-capability inbound substrate). Each
// dispatchable target declares the callers it admits; `canDispatch` consumes
// `allowedCallers` via the dispatch handler. These tests pin the inbound
// registry's consistency with the caller-side `allowedDispatchTargets`.

import { describe, expect, test } from "bun:test";

import { ActorName } from "../../src/cli/registry.ts";
import { actorSpecFor, prxActorRegistry } from "../../src/cli/registry.data.ts";
import { SESSION_PROFILES, sessionProfileNames } from "../../src/machine/runtime_profiles.ts";

const VALID_ACTORS: ReadonlySet<string> = new Set(ActorName.options);

describe("ActorSpec registry — shape", () => {
  test("every dispatchable actor has a non-empty allowedCallers", () => {
    const dispatchable = prxActorRegistry.filter((s) => s.dispatchable);
    expect(dispatchable.length).toBeGreaterThan(0);
    for (const spec of dispatchable) {
      expect(
        spec.allowedCallers.length,
        `dispatchable actor '${spec.name}' must admit at least one caller`,
      ).toBeGreaterThan(0);
    }
  });

  test("every allowedCaller is a canonical ActorName", () => {
    for (const spec of prxActorRegistry) {
      for (const caller of spec.allowedCallers) {
        expect(
          VALID_ACTORS.has(caller),
          `actor '${spec.name}' lists non-canonical caller '${caller}'`,
        ).toBe(true);
      }
    }
  });

  test("a non-dispatchable / unregistered actor denies every caller", () => {
    // `model` IS dispatchable; pick an actor with no inbound spec.
    const spec = actorSpecFor("home");
    expect(spec.dispatchable).toBe(false);
    expect(spec.allowedCallers).toEqual([]);
  });

  test("publisher (forge) admits implement and author as callers (ai-home-2ow2v)", () => {
    // ai-home-2ow2v: the author profile reaches the `github` write surface
    // (pr open/comment/edit, ready/draft) via dispatch to the forge actor, so
    // `publisher` must admit `author` alongside `implement`.
    const spec = actorSpecFor("publisher");
    expect(spec.dispatchable).toBe(true);
    expect(spec.allowedCallers).toContain("implement");
    expect(spec.allowedCallers).toContain("author");
  });
});

describe("ActorSpec registry — consistency with caller-side allowedDispatchTargets", () => {
  test("every profile's outbound target lists that profile as an allowed caller (inbound)", () => {
    for (const source of sessionProfileNames) {
      for (const target of SESSION_PROFILES[source].allowedDispatchTargets) {
        const spec = actorSpecFor(target);
        expect(
          spec.dispatchable,
          `target '${target}' (reachable from '${source}') must be dispatchable`,
        ).toBe(true);
        expect(
          spec.allowedCallers as readonly string[],
          `target '${target}' must admit caller '${source}'`,
        ).toContain(source);
      }
    }
  });
});
