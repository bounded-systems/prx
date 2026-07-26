// GH-1558 — publisher actor catalog delta. Foundation ticket of the GH-1398
// publisher-actor chain: registers `publisher` in the XState/actor model so
// the verb-move tickets (#2–#5) can land against a stable catalog. The
// `prx publisher` CLI is intentionally NOT shipped here — only the catalog,
// scope, and ownership entries.
//
// Assertions are membership/ownership-based. We do NOT snapshot `emit()`
// action strings: per the xstate-system-ts projection, emit() actions are
// stripped from the serialized graph, so catalog/event-owner/scope
// membership is the durable surface.

import { describe, expect, test } from "bun:test";

import {
  actorForEvent,
  actorScopes,
  eventOwnerMap,
  rawFieldOwnerMap,
  toolActorCatalog,
  toolActors,
} from "../../src/machine/actors.ts";

describe("GH-1558: publisher actor catalog entry", () => {
  test("publisher is registered in toolActors", () => {
    expect(toolActors).toContain("publisher");
  });

  test("toolActorCatalog.publisher has the verification_publication/cli/publication shape", () => {
    const publisher = toolActorCatalog.publisher;
    expect(publisher.actor).toBe("publisher");
    expect(publisher.tier).toBe("verification_publication");
    expect(publisher.kind).toBe("cli");
    expect(publisher.domain).toBe("publication");
  });

  test("publisher emits the forge request/effect set (git-write moved to keeper, GH-2348.3)", () => {
    const expected = new Set([
      // Moved from doctor (request intents):
      "PR_AUTOMERGE_REQUESTED",
      "PR_READY_REQUESTED",
      "PR_DRAFT_REQUESTED",
      // Moved from doctor (automerge phase-writes):
      "AUTOMERGE_ENABLED",
      "AUTOMERGE_DISABLED",
      // Forge intents (PUSH_REQUESTED / BRANCH_OP_REQUESTED moved to keeper):
      "PR_OPEN_REQUESTED",
      "PR_UPDATE_REQUESTED",
      // ai-home-2ow2v: forge comment/edit verbs.
      "PR_COMMENT_REQUESTED",
      "PR_EDIT_REQUESTED",
      "ISSUE_CLOSE_REQUESTED",
      // GH-2382: bd→GH issue-edit intent (lossless title/body/label reconcile).
      "ISSUE_UPDATE_REQUESTED",
    ]);
    expect(new Set(toolActorCatalog.publisher.emits)).toEqual(expected);
  });

  test("publisher accepts the forge verb surface (push/branch moved to keeper, GH-2348.3)", () => {
    const expected = new Set([
      "pr.open",
      "pr.update",
      // ai-home-2ow2v: forge comment/edit verbs.
      "pr.comment",
      "pr.edit",
      "pr.merge",
      "pr.ready",
      "pr.draft",
      "issue.close",
      // GH-2382: the bd→GH issue-edit verb surface.
      "issue.update",
    ]);
    expect(new Set(toolActorCatalog.publisher.accepts)).toEqual(expected);
  });

  test("ISSUE_UPDATE_REQUESTED is owned by publisher (GH-2382)", () => {
    expect(eventOwnerMap.ISSUE_UPDATE_REQUESTED).toBe("publisher");
    expect(actorForEvent("ISSUE_UPDATE_REQUESTED")).toBe("publisher");
  });
});

describe("GH-2348.3: keeper actor catalog entry", () => {
  test("keeper is registered in toolActors", () => {
    expect(toolActors).toContain("keeper");
  });

  test("keeper has the verification_publication/cli/ref_custody git-write shape", () => {
    const keeper = toolActorCatalog.keeper;
    expect(keeper.actor).toBe("keeper");
    expect(keeper.tier).toBe("verification_publication");
    expect(keeper.kind).toBe("cli");
    expect(keeper.domain).toBe("ref_custody");
    // GH-2381: keeper gained the commit-materialization intents (write-tree at
    // stage, commit-tree at publish) — still the sole git-writer.
    expect(new Set(keeper.emits)).toEqual(
      new Set([
        "PUSH_REQUESTED",
        "BRANCH_OP_REQUESTED",
        "TREE_MATERIALIZE_REQUESTED",
        "COMMIT_MATERIALIZE_REQUESTED",
      ]),
    );
    expect(new Set(keeper.accepts)).toEqual(
      new Set(["push", "branch", "write-tree", "commit-tree"]),
    );
  });

  test("publisher no longer carries the git-write intents", () => {
    expect(toolActorCatalog.publisher.emits).not.toContain("PUSH_REQUESTED");
    expect(toolActorCatalog.publisher.emits).not.toContain("BRANCH_OP_REQUESTED");
    expect(toolActorCatalog.publisher.accepts).not.toContain("push");
    expect(toolActorCatalog.publisher.accepts).not.toContain("branch");
  });
});

describe("GH-1558: doctor.emits trimmed for the publisher move", () => {
  test("doctor.emits no longer contains the moved PR-transition requests", () => {
    const doctorEmits = new Set(toolActorCatalog.doctor.emits);
    expect(doctorEmits.has("PR_AUTOMERGE_REQUESTED")).toBe(false);
    expect(doctorEmits.has("PR_READY_REQUESTED")).toBe(false);
    expect(doctorEmits.has("PR_DRAFT_REQUESTED")).toBe(false);
  });

  test("doctor.emits keeps the report-only inventory event", () => {
    expect(toolActorCatalog.doctor.emits).toContain("PR_INVENTORY_READ");
  });
});

describe("GH-1558: eventOwnerMap moved entries point at publisher", () => {
  const movedEvents = [
    "PR_AUTOMERGE_REQUESTED",
    "PR_READY_REQUESTED",
    "PR_DRAFT_REQUESTED",
    "AUTOMERGE_ENABLED",
    "AUTOMERGE_DISABLED",
  ] as const;

  for (const event of movedEvents) {
    test(`${event} is owned by publisher`, () => {
      expect(eventOwnerMap[event]).toBe("publisher");
    });
  }
});

describe("GH-2348.3: forge intents stay on publisher, git-write intents move to keeper", () => {
  // Forge intents (PR/issue lifecycle via the gh tool) remain publisher-owned.
  const publisherIntents = [
    "PR_OPEN_REQUESTED",
    "PR_UPDATE_REQUESTED",
    "ISSUE_CLOSE_REQUESTED",
  ] as const;
  // Git-write intents (push, branch ops via the git tool) move to keeper.
  const keeperIntents = ["PUSH_REQUESTED", "BRANCH_OP_REQUESTED"] as const;

  for (const event of publisherIntents) {
    test(`${event} is owned by publisher (forge)`, () => {
      expect(eventOwnerMap[event]).toBe("publisher");
    });
  }
  for (const event of keeperIntents) {
    test(`${event} is owned by keeper (git-write)`, () => {
      expect(eventOwnerMap[event]).toBe("keeper");
    });
  }
});

describe("GH-1558/GH-2348.3: actorScopes include publisher and keeper", () => {
  for (const actor of ["publisher", "keeper"] as const) {
    test(`actorScopes.pr includes ${actor}`, () => {
      expect(actorScopes.pr).toContain(actor);
    });
    test(`actorScopes.workflow includes ${actor}`, () => {
      expect(actorScopes.workflow).toContain(actor);
    });
  }
});

describe("GH-1558: publisher owns intents only, not raw fields", () => {
  test("rawFieldOwnerMap has no entries owned by publisher", () => {
    const publisherOwnedFields = Object.entries(rawFieldOwnerMap).filter(
      ([, owner]) => owner === "publisher",
    );
    expect(publisherOwnedFields).toEqual([]);
  });
});

describe("GH-1558: actorForEvent round-trip for publisher events", () => {
  test("actorForEvent resolves a moved event to publisher", () => {
    expect(actorForEvent("PR_AUTOMERGE_REQUESTED")).toBe("publisher");
  });

  test("actorForEvent resolves a git-write event to keeper (GH-2348.3)", () => {
    expect(actorForEvent("PUSH_REQUESTED")).toBe("keeper");
  });
});
