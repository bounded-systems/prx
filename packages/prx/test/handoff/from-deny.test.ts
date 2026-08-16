// GH-2348.3: deny-handoff recipient routing — git-write → keeper (split out of
// publisher), forge/PR → publisher, gh edit → author, bd → triage.
//
// Plus the two enqueue seams that translate a deny into a routed handoff:
//   - buildPolicyEnqueueAdapter (policy-table deny → mapped enqueue result)
//   - enqueueFromFlagLayerDeny  (disallowedTools deny → raw EnqueueResult)
//
// GH-1012: the handoff queue was bd/Dolt-backed and has been removed. The
// enqueue itself is now a no-op that reports the queue as unavailable
// ("bd-unprovisioned"); the routing + cross-repo guard behavior is retained
// and exercised here.

import { describe, expect, test } from "bun:test";

import {
  buildPolicyEnqueueAdapter,
  enqueueFromFlagLayerDeny,
  recipientForDeniedVerb,
} from "../../src/handoff/from-deny.ts";
import type { EnqueueFromPolicyDenyDeps } from "../../src/handoff/from-deny.ts";
import type { WorkUnitId } from "@bounded-systems/machine-schema";

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

// ── deterministic deps ──────────────────────────────────────────────────────

const deterministicDeps: EnqueueFromPolicyDenyDeps = {
  now: () => new Date("2026-06-06T00:00:00Z"),
  repoSlug: () => "bounded-systems/prx",
  sourceActor: () => "executor",
  workUnitId: () => "GH-1397" as WorkUnitId,
};

const denyInput = {
  tool: "git" as const,
  subcommand: "push",
  state: "planning" as const,
  role: "planner" as const,
  owningRoles: ["keeper" as const],
};

// ── buildPolicyEnqueueAdapter ────────────────────────────────────────────────

describe("buildPolicyEnqueueAdapter", () => {
  test("no persistent backend: a deny maps to {skipped, bd-unprovisioned}", async () => {
    // GH-1012: the bd/Dolt-backed queue is gone, so every non-cross-repo deny
    // reports the queue as unavailable rather than enqueuing a row.
    const adapter = buildPolicyEnqueueAdapter(deterministicDeps);
    const result = await adapter(denyInput);
    expect(result).toEqual({ kind: "skipped", reason: "bd-unprovisioned" });
  });

  test("cross-repo deny maps to {skipped, cross-repo}", async () => {
    const adapter = buildPolicyEnqueueAdapter({
      ...deterministicDeps,
      // The queue is per-repo; an enqueue whose repoSlug differs from the
      // current repo is refused by the cross-repo guard.
      currentRepoSlug: () => "someone-else/other-repo",
    });
    const result = await adapter(denyInput);
    expect(result).toEqual({ kind: "skipped", reason: "cross-repo" });
  });
});

// ── enqueueFromFlagLayerDeny ─────────────────────────────────────────────────

describe("enqueueFromFlagLayerDeny", () => {
  const baseInput = {
    tool: "Bash(git push:*)",
    args: { cmd: "git push" },
    workUnitId: "GH-1397" as WorkUnitId,
    repoSlug: "bounded-systems/prx",
    sourceActor: "executor",
  };

  test("reports the removed queue as bd-unprovisioned", async () => {
    const result = await enqueueFromFlagLayerDeny(baseInput, {
      now: () => new Date("2026-06-06T00:00:00Z"),
    });
    expect(result.kind).toBe("bd-unprovisioned");
  });

  test("cross-repo deny is refused before the no-op enqueue", async () => {
    const result = await enqueueFromFlagLayerDeny(baseInput, {
      now: () => new Date("2026-06-06T00:00:00Z"),
      currentRepoSlug: () => "someone-else/other-repo",
    });
    expect(result.kind).toBe("cross-repo-refused");
  });
});
