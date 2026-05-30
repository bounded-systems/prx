// GH-1943 — contract pins for the `<actor> agent` verb-shape ADR.
//
// This file asserts the substrate invariants the GH-1943 ADR
// (`docs/spikes/GH-1943-actor-agent-verb-shape.md`) rests on. It pins
// the pre-rename shape so the follow-up registry-rename PR (§7 step 2
// of the ADR) has a concrete checkpoint to diff against, and it
// guarantees the four sibling spike actors (GH-1944 scout, GH-1945
// doctor, GH-1946 delegate, GH-1947 reviewer) can register their
// `<actor> agent` lifecycle entries against the existing canonical
// `ActorName` enum without further substrate work.
//
// The ADR's §2 decision is "agent replaces session as the canonical
// lifecycle-entry verb." The rename itself is out of scope here
// (tracked at ADR §7 step 2); these tests stay green by asserting
// what's true today, with one `it.todo` per post-rename assertion so
// the rename PR has a placeholder to fill in.

import { describe, expect, test } from "bun:test";

import {
  prxCommandRegistry,
} from "../../src/cli/registry.data.ts";
import { ActorName } from "../../src/cli/registry.ts";
import {
  defaultDispatchCapabilities,
  dispatchActors,
} from "../../src/machine/dispatch.ts";
import {
  sessionProfileNames,
  taskAgentRoles,
} from "../../src/machine/runtime_profiles.ts";

// The three sibling profile-binding spikes whose actor names are
// already in `ActorName`. The fourth spike (GH-1947, review actor)
// adds a new canonical actor as part of its own work — see the
// `review actor` assertion below for the explicit pin on that
// substrate gap.
const siblingSpikeActorsPresent = ["scout", "doctor", "delegate"] as const;

describe("GH-1943 — agent verb-shape ADR substrate", () => {
  test("every sessionProfileName has a canonical lifecycle entry pointing at the profile", () => {
    // Rename shape pin. GH-1981 carved out `implement` first; GH-2380
    // swept intake/triage/submit/author to `<name> agent` (headless-
    // first). `plan` is intentionally NOT an `agent`-verb profile — it
    // keeps the `plan session` shape — so it is the lone exception here.
    for (const profile of sessionProfileNames) {
      // GH-1981: implement's canonical entry is `implement agent`.
      // GH-2394: scratch is a bare command (`prx scratch`) — work-unit-UNBOUND
      // and not part of the `<profile> session` lifecycle family, so its
      // canonical entry name has no ` session` suffix.
      const expectedName =
        profile === "plan"
          ? "plan session"
          : profile === "scratch"
            ? "scratch"
            : `${profile} agent`;
      const entry = prxCommandRegistry.find((c) => c.name === expectedName);
      expect(
        entry,
        `expected registry entry '${expectedName}' for session profile '${profile}'`,
      ).toBeDefined();
      expect(entry?.session_profile).toBe(profile);
    }
  });

  test("GH-1981 — `implement session` survives as a one-cycle deprecation alias", () => {
    // The renamed shape ships with a deprecation alias so operator
    // muscle memory keeps working for one cycle. The alias points at
    // the canonical `implement agent` verb and carries a stderr hint
    // (mirrors the GH-1166 retired-shorthand playbook).
    const alias = prxCommandRegistry.find(
      (c) => c.name === "implement session",
    );
    expect(alias, "`implement session` deprecation alias must exist").toBeDefined();
    expect(alias?.deprecation?.alias_for).toBe("implement agent");
    expect(alias?.session_profile).toBeUndefined();
    expect(alias?.deprecation?.stderr_hint ?? "").toMatch(/prx implement agent/);
  });

  test("every sessionProfileName is a known dispatch source", () => {
    // GH-1943 §4: dispatch-actor promotion lifts these source entries
    // into the new top-level `dispatch` actor unchanged. This pin
    // guarantees the source list is already complete — the lift is a
    // relocation, not a widening of the dispatch surface.
    for (const profile of sessionProfileNames) {
      expect(
        dispatchActors as readonly string[],
        `session profile '${profile}' must appear in dispatchActors so the GH-1943 §4 dispatch-actor lift relocates it without widening the source set`,
      ).toContain(profile);
      expect(
        defaultDispatchCapabilities[profile],
        `defaultDispatchCapabilities should declare the target allowlist for source '${profile}'`,
      ).toBeDefined();
    }
  });

  test("scout/doctor/delegate spike actors already exist in ActorName (GH-1944/1945/1946)", () => {
    // Three of the four sibling spikes file `<actor> agent` entries
    // against actor names that are already canonical. Pinning this
    // means the rename PR for those three spikes doesn't need an
    // enum widening — only the registry entry add.
    for (const actor of siblingSpikeActorsPresent) {
      expect(
        ActorName.options as readonly string[],
        `sibling spike actor '${actor}' should already be in canonical ActorName`,
      ).toContain(actor);
    }
  });

  test("review actor is NOT yet in ActorName — substrate gap GH-1947 closes", () => {
    // GH-1947 (review spike) lands the `review` canonical actor as
    // part of its own work. Pinning the gap here so the GH-1947 PR
    // has to either flip this assertion or document why the actor
    // name lives elsewhere. (taskAgentRoles already has 'reviewer'
    // for the role-axis side; the actor-axis name is open.)
    const reviewActorPresent =
      (ActorName.options as readonly string[]).includes("review") ||
      (ActorName.options as readonly string[]).includes("reviewer");
    expect(
      reviewActorPresent,
      "review actor name is intentionally absent from ActorName today; GH-1947 lands it",
    ).toBe(false);
  });

  test("scout is dispatch-only (GH-1386) — present in dispatchActors", () => {
    // GH-1943 §5 records scout's verb as `prx dispatch --actor=scout`,
    // not `prx scout agent`. Pin that scout sits on the dispatch
    // axis so the GH-1944 spike's profile-binding decision lands
    // against the existing dispatch matrix rather than the session-
    // profile list.
    expect(dispatchActors as readonly string[]).toContain("scout");
    expect(defaultDispatchCapabilities.scout).toEqual([]);
  });

  test("sessionProfileNames and taskAgentRoles stay disjoint (GH-1822 invariant)", () => {
    // GH-1822 carved taskAgentRoles out of sessionProfileNames to
    // keep blast radius narrow on the role-axis side. Both lists
    // collapse onto the `agent` noun post-rename but stay on
    // separate lists; this invariant survives the GH-1943 rename.
    const sessionSet = new Set<string>(sessionProfileNames);
    for (const role of taskAgentRoles) {
      expect(
        sessionSet.has(role),
        `'${role}' is in both sessionProfileNames and taskAgentRoles — GH-1822 says they must stay disjoint`,
      ).toBe(false);
    }
  });

  // Trivial sanity pin — keeps the ADR path stable for downstream references
  // (sibling-spike comments link to this file). The ADR doc is ai-home content,
  // absent in the prx repo, so skip there (Bun.file().size is 0 for a missing file).
  const adrPath = new URL(
    "../../../../docs/spikes/GH-1943-actor-agent-verb-shape.md",
    import.meta.url,
  );
  test.skipIf(Bun.file(adrPath).size === 0)("ADR document is checked in at the conventional path", () => {
    expect(Bun.file(adrPath).size > 0).toBe(true);
  });
});

describe("GH-1943 — post-rename gates (ADR §7 step 2; tracked separately)", () => {
  // These placeholders document the assertions the rename PR is
  // expected to flip on. `test.skip` keeps them visible in the test
  // tree without failing CI today; the rename PR removes the
  // `.skip` and implements the body.
  test.skip("every entry in agentProfileNames registers an `<name> agent` lifecycle action", () => {});
  test.skip("no registry entry registers a `<name> session` action (deprecation aliases excepted)", () => {});
  test.skip("`dispatch` is a registered top-level actor with a defaultDispatchCapabilities-derived source→target table (ADR §4)", () => {});
});
