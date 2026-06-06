// GH-2348.3: deny-handoff recipient routing — git-write → keeper (split out of
// publisher), forge/PR → publisher, gh edit → author, bd → triage.
//
// Plus the two enqueue seams that translate a deny into a routed handoff:
//   - buildPolicyEnqueueAdapter (policy-table deny → mapped enqueue result)
//   - enqueueFromFlagLayerDeny  (disallowedTools deny → raw EnqueueResult)
// Both inject the bd seam via `execBd` so no real bd/CAS/git is touched.

import { describe, expect, test } from "bun:test";

import {
  buildPolicyEnqueueAdapter,
  enqueueFromFlagLayerDeny,
  recipientForDeniedVerb,
} from "../../src/handoff/from-deny.ts";
import type { HandoffStoreDeps } from "../../src/handoff/store.ts";
import type { BdExecOptions, BdExecResult } from "@bounded-systems/bd";
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

// ── shared bd fake ──────────────────────────────────────────────────────────

/**
 * An in-memory bd seam: `remember` records the row keyed by `--key`, and
 * `memories` returns the rows under a prefix. Backing the two with one map
 * makes the idempotency (duplicate) path real — a second enqueue of the same
 * envelope finds the row it just wrote.
 */
function makeFakeBd(
  rows: Map<string, string> = new Map(),
): HandoffStoreDeps["execBd"] {
  return (opts: BdExecOptions): BdExecResult => {
    if (opts.subcommand === "remember") {
      const body = opts.args[0] as string;
      const keyIdx = opts.args.indexOf("--key");
      const key = (keyIdx >= 0 ? opts.args[keyIdx + 1] : "") as string;
      rows.set(key, body);
      return { exitCode: 0, stdout: "{}", stderr: "", policy: null };
    }
    if (opts.subcommand === "memories") {
      const prefix = opts.args[0] as string;
      const out: Array<{ key: string; body: string }> = [];
      for (const [k, v] of rows) if (k.startsWith(prefix)) out.push({ key: k, body: v });
      return { exitCode: 0, stdout: JSON.stringify(out), stderr: "", policy: null };
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected: ${opts.subcommand}`, policy: null };
  };
}

const unprovisionedBd: HandoffStoreDeps["execBd"] = () => ({
  exitCode: 1,
  stdout: "",
  stderr: "bd: not provisioned",
  policy: null,
});

const deterministicDeps = (execBd: HandoffStoreDeps["execBd"]) => ({
  execBd,
  now: () => new Date("2026-06-06T00:00:00Z"),
  repoSlug: () => "bounded-systems/prx",
  sourceActor: () => "executor",
  workUnitId: () => "GH-1397" as WorkUnitId,
});

const denyInput = {
  tool: "git" as const,
  subcommand: "push",
  state: "planning" as const,
  role: "planner" as const,
  owningRoles: ["keeper" as const],
};

// ── buildPolicyEnqueueAdapter ────────────────────────────────────────────────

describe("buildPolicyEnqueueAdapter", () => {
  test("created: a fresh deny enqueues and maps to {enqueued, handoffId}", async () => {
    const adapter = buildPolicyEnqueueAdapter(deterministicDeps(makeFakeBd()));
    const result = await adapter(denyInput);
    expect(result.kind).toBe("enqueued");
    if (result.kind === "enqueued") expect(result.handoffId).toMatch(/^H/);
  });

  test("duplicate: the same deny twice returns the same handoffId", async () => {
    const rows = new Map<string, string>();
    const adapter = buildPolicyEnqueueAdapter(deterministicDeps(makeFakeBd(rows)));
    const first = await adapter(denyInput);
    const second = await adapter(denyInput);
    expect(first.kind).toBe("enqueued");
    expect(second.kind).toBe("enqueued");
    if (first.kind === "enqueued" && second.kind === "enqueued") {
      expect(second.handoffId).toBe(first.handoffId);
    }
  });

  test("bd-unprovisioned maps to {skipped, bd-unprovisioned}", async () => {
    const adapter = buildPolicyEnqueueAdapter(deterministicDeps(unprovisionedBd));
    const result = await adapter(denyInput);
    expect(result).toEqual({ kind: "skipped", reason: "bd-unprovisioned" });
  });

  test("cross-repo deny maps to {skipped, cross-repo}", async () => {
    const adapter = buildPolicyEnqueueAdapter({
      ...deterministicDeps(makeFakeBd()),
      // The queue is per-repo; an enqueue whose repoSlug differs from the
      // current repo is refused before any bd write.
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

  test("defaults the recipient to publisher and stamps flag-layer-deny", async () => {
    const result = await enqueueFromFlagLayerDeny(baseInput, {
      execBd: makeFakeBd(),
      now: () => new Date("2026-06-06T00:00:00Z"),
    });
    expect(result.kind).toBe("created");
    if (result.kind === "created") {
      expect(result.envelope.targetActor).toBe("publisher");
      expect(result.envelope.denialReason).toBe("flag-layer-deny");
      expect(result.envelope.intent.verb).toBe("Bash(git push:*)");
    }
  });

  test("honors an explicit target override", async () => {
    const result = await enqueueFromFlagLayerDeny(
      { ...baseInput, target: "keeper" },
      { execBd: makeFakeBd(), now: () => new Date("2026-06-06T00:00:00Z") },
    );
    expect(result.kind).toBe("created");
    if (result.kind === "created") expect(result.envelope.targetActor).toBe("keeper");
  });

  test("propagates a bd-unprovisioned result unmapped", async () => {
    const result = await enqueueFromFlagLayerDeny(baseInput, { execBd: unprovisionedBd });
    expect(result.kind).toBe("bd-unprovisioned");
  });

  test("falls back to env sourceActor + resolved/unknown repoSlug when omitted", async () => {
    // Omitting repoSlug/sourceActor exercises the default seams:
    // sourceActorFromEnv (PRX_AGENT_ROLE → "executor") and tryRepoSlug
    // (git resolve, try/catch → "unknown-repo" on failure).
    const result = await enqueueFromFlagLayerDeny(
      { tool: "Edit", args: null },
      { execBd: makeFakeBd(), now: () => new Date("2026-06-06T00:00:00Z") },
    );
    expect(result.kind).toBe("created");
    if (result.kind === "created") {
      expect(result.envelope.sourceActor.length).toBeGreaterThan(0);
      expect(result.envelope.repoSlug.length).toBeGreaterThan(0);
    }
  });
});
