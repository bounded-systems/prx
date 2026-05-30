// GH-2348.3: deny-handoff recipient routing — git-write → keeper (split out of
// publisher), forge/PR → publisher, gh edit → author, bd → triage.

import { describe, expect, test } from "bun:test";

import { recipientForDeniedVerb } from "../../src/handoff/from-deny.ts";

describe("recipientForDeniedVerb (GH-2348.3 keeper split)", () => {
  test("git-write verbs route to keeper", () => {
    expect(recipientForDeniedVerb("git", "push")).toBe("keeper");
    expect(recipientForDeniedVerb("git", "branch")).toBe("keeper");
    expect(recipientForDeniedVerb("git", "commit")).toBe("keeper");
    expect(recipientForDeniedVerb("git", "merge")).toBe("keeper");
  });

  test("gh forge verbs stay on publisher", () => {
    expect(recipientForDeniedVerb("gh", "pr.create")).toBe("publisher");
    expect(recipientForDeniedVerb("gh", "pr.merge")).toBe("publisher");
  });

  test("gh edit routes to author; bd routes to triage", () => {
    expect(recipientForDeniedVerb("gh", "edit")).toBe("author");
    expect(recipientForDeniedVerb("bd", "create")).toBe("triage");
  });
});
