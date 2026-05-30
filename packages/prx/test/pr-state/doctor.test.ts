import { describe, expect, test } from "bun:test";

import {
  gateTransition,
  loadInventory,
  runInventory,
  type DoctorInventory,
  type DoctorTarget,
} from "../../src/pr-state/doctor.ts";
import type { PrCommentsResult } from "../../src/pr-state/github.ts";

const target: DoctorTarget = {
  workUnitId: "GH-885",
  repoPath: "/repo",
};

function comments(overrides: Partial<PrCommentsResult["pr"]> = {}): PrCommentsResult {
  return {
    repoPath: "/repo",
    pr: {
      number: 100,
      title: "Doctor wires up automerge",
      url: "https://github.com/owner/repo/pull/100",
      isDraft: false,
      baseRefName: "main",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
      autoMergeEnabled: false,
      autoMergeRequest: null,
      ...overrides,
    },
    reviewAdded: true,
    reviewApproved: true,
    agentReview: false,
    humanReview: true,
    unresolvedThreads: 0,
    threads: [],
  };
}

const enforcedProtection = () => ({
  requiredApprovingReviewCount: 1,
  requireCodeOwnerReviews: false,
});

const zeroApprovalsProtection = () => ({
  requiredApprovingReviewCount: 0,
  requireCodeOwnerReviews: false,
});

const codeOwnersOnlyProtection = () => ({
  requiredApprovingReviewCount: 0,
  requireCodeOwnerReviews: true,
});

function recordingOutput(): { lines: string[]; errors: string[]; output: { log: (l: string) => void; error: (l: string) => void } } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    output: {
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
    },
  };
}

describe("loadInventory", () => {
  test("projects PrCommentsResult into a typed inventory snapshot", () => {
    const inventory = loadInventory(target, {
      fetchPrComments: () =>
        comments({
          autoMergeEnabled: true,
          autoMergeRequest: { enabledBy: "doctor-bot", mergeMethod: "SQUASH" },
        }),
      fetchBranchProtection: () => enforcedProtection(),
    });
    expect(inventory).toMatchObject({
      prNumber: 100,
      isDraft: false,
      baseRefName: "main",
      reviewDecision: "APPROVED",
      ciState: "passed",
      mergeable: "MERGEABLE",
      unresolvedThreads: 0,
      behindBy: 0,
      autoMergeEnabled: true,
      autoMergeMethod: "SQUASH",
      autoMergeEnabledBy: "doctor-bot",
      protection: { requiredApprovingReviewCount: 1, requireCodeOwnerReviews: false },
    });
  });

  test("derives behindBy=1 when mergeStateStatus=BEHIND", () => {
    const inventory = loadInventory(target, {
      fetchPrComments: () => comments({ mergeStateStatus: "BEHIND", mergeable: "MERGEABLE" }),
      fetchBranchProtection: () => enforcedProtection(),
    });
    expect(inventory.behindBy).toBe(1);
  });

  test("roundtrips protection=null when no rule exists on base", () => {
    const inventory = loadInventory(target, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: () => null,
    });
    expect(inventory.protection).toBeNull();
  });

  test("passes baseRefName from comments through to the protection fetcher", () => {
    let receivedBranch = "";
    loadInventory(target, {
      fetchPrComments: () => comments({ baseRefName: "release/2026-05" }),
      fetchBranchProtection: (_repo, branch) => {
        receivedBranch = branch;
        return enforcedProtection();
      },
    });
    expect(receivedBranch).toBe("release/2026-05");
  });
});

describe("gateTransition", () => {
  function inv(overrides: Partial<DoctorInventory> = {}): DoctorInventory {
    return {
      prNumber: 100,
      prUrl: "https://example/100",
      prTitle: "Title",
      isDraft: false,
      baseRefName: "main",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
      ciState: "passed",
      unresolvedThreads: 0,
      behindBy: 0,
      autoMergeEnabled: false,
      autoMergeMethod: null,
      autoMergeEnabledBy: null,
      protection: enforcedProtection(),
      ...overrides,
    };
  }

  test("draft has no gate (always ok)", () => {
    expect(gateTransition("draft", inv()).ok).toBeTrue();
    expect(gateTransition("draft", inv({ isDraft: true })).ok).toBeTrue();
  });

  test("ready blocks on failing CI", () => {
    const result = gateTransition("ready", inv({ ciState: "failed" }));
    expect(result.ok).toBeFalse();
    expect(result.blockers.some((b) => b.predicate === "ci.state=failed")).toBeTrue();
  });

  test("ready blocks on unresolved threads", () => {
    const result = gateTransition("ready", inv({ unresolvedThreads: 2 }));
    expect(result.ok).toBeFalse();
    expect(result.blockers.some((b) => b.predicate.includes("unresolvedThreads=2"))).toBeTrue();
  });

  test("merge blocks on draft PR", () => {
    const result = gateTransition("merge", inv({ isDraft: true }));
    expect(result.blockers.some((b) => b.predicate === "pr.isDraft=true")).toBeTrue();
  });

  test("merge waits on review!=APPROVED (queues automerge instead of vetoing)", () => {
    // GH-1354: review.decision is a transient signal — enablePullRequestAutoMerge
    // queues safely until approval lands. Predicate is now class=waiting and
    // gate.ok is true (no hard blockers).
    const result = gateTransition("merge", inv({ reviewDecision: "CHANGES_REQUESTED" }));
    expect(result.ok).toBeTrue();
    expect(
      result.blockers.some(
        (b) => b.predicate.includes("review.decision=") && b.class === "waiting",
      ),
    ).toBeTrue();
  });

  test("merge skips review.decision when protection requires 0 approvals", () => {
    const result = gateTransition(
      "merge",
      inv({ reviewDecision: null, protection: zeroApprovalsProtection() }),
    );
    expect(result.ok).toBeTrue();
    expect(result.blockers.some((b) => b.predicate.includes("review.decision="))).toBeFalse();
  });

  test("merge skips review.decision when no protection rule exists", () => {
    const result = gateTransition(
      "merge",
      inv({ reviewDecision: null, protection: null }),
    );
    expect(result.ok).toBeTrue();
    expect(result.blockers.some((b) => b.predicate.includes("review.decision="))).toBeFalse();
  });

  test("merge enforces review.decision (waiting) when require_code_owner_reviews=true", () => {
    // GH-1346: code-owners protection counts as enforced. GH-1354: enforced
    // review-decision is a waiting condition, not a hard blocker — gate.ok
    // stays true so automerge can queue.
    const result = gateTransition(
      "merge",
      inv({ reviewDecision: null, protection: codeOwnersOnlyProtection() }),
    );
    expect(result.ok).toBeTrue();
    expect(
      result.blockers.some(
        (b) => b.predicate.includes("review.decision=") && b.class === "waiting",
      ),
    ).toBeTrue();
  });

  test("merge blocks on behind base", () => {
    const result = gateTransition("merge", inv({ behindBy: 1 }));
    expect(result.blockers.some((b) => b.predicate.includes("remoteFresh"))).toBeTrue();
  });

  test("merge passes on full I04 conditions", () => {
    expect(gateTransition("merge", inv()).ok).toBeTrue();
  });

  // GH-2249 (I-PROV1): the provenance axis hard-blocks merge AND ready only on
  // "unsigned"; absent / "unchecked" / "verified" leave the gate unchanged.
  for (const verb of ["merge", "ready"] as const) {
    test(`${verb} blocks when provenance is unsigned`, () => {
      const result = gateTransition(verb, inv({ provenance: "unsigned" }));
      expect(result.ok).toBeFalse();
      expect(
        result.blockers.some((b) => b.predicate === "provenance.signed=unsigned"),
      ).toBeTrue();
    });

    test(`${verb} passes when provenance is verified`, () => {
      expect(gateTransition(verb, inv({ provenance: "verified" })).ok).toBeTrue();
    });

    test(`${verb} passes when provenance is unchecked or absent (unchanged)`, () => {
      expect(gateTransition(verb, inv({ provenance: "unchecked" })).ok).toBeTrue();
      expect(gateTransition(verb, inv()).ok).toBeTrue(); // absent ⇒ non-blocking
    });
  }
});

describe("loadInventory — provenance axis injection (GH-2249)", () => {
  test("stamps the injected provenanceAxis onto the inventory", () => {
    const inventory = loadInventory(target, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: () => enforcedProtection(),
      provenanceAxis: "unsigned",
    });
    expect(inventory.provenance).toBe("unsigned");
  });

  test("leaves provenance absent when no axis is injected (gate unchanged)", () => {
    const inventory = loadInventory(target, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: () => enforcedProtection(),
    });
    expect(inventory.provenance).toBeUndefined();
  });
});

describe("runInventory", () => {
  test("emits json snapshot with per-verb gate breakdown", () => {
    const rec = recordingOutput();
    const code = runInventory(target, "json", rec.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: () => enforcedProtection(),
    });
    expect(code).toBe(0);
    expect(rec.lines).toHaveLength(1);
    const parsed = JSON.parse(rec.lines[0]!);
    expect(parsed.target).toBe("GH-885");
    expect(parsed.gates.merge.ok).toBeTrue();
    expect(parsed.gates.draft.ok).toBeTrue();
    expect(parsed.gates.merge.dispositions.reviewGate).toBe("enforced");
    expect(parsed.inventory.protection).toEqual({
      requiredApprovingReviewCount: 1,
      requireCodeOwnerReviews: false,
    });
  });

  test("plain output surfaces gate merge.review: skipped on a 0-approvals branch", () => {
    const rec = recordingOutput();
    const code = runInventory(target, "plain", rec.output, {
      fetchPrComments: () => comments({ reviewDecision: null }),
      fetchBranchProtection: () => zeroApprovalsProtection(),
    });
    expect(code).toBe(0);
    const text = rec.lines.join("\n");
    expect(text).toContain("gate merge.review: skipped (protection requires 0 approvals)");
    expect(text).toContain("protection:        requires 0 approval(s), code-owners=false");
  });

  test("plain output reports (none on <base>) when no protection rule exists", () => {
    const rec = recordingOutput();
    const code = runInventory(target, "plain", rec.output, {
      fetchPrComments: () => comments({ reviewDecision: null, baseRefName: "main" }),
      fetchBranchProtection: () => null,
    });
    expect(code).toBe(0);
    const text = rec.lines.join("\n");
    expect(text).toContain("protection:        (none on main)");
    expect(text).toContain("gate merge.review: skipped");
  });

  test("json output surfaces dispositions.reviewGate=skipped when GitHub gate is open", () => {
    const rec = recordingOutput();
    const code = runInventory(target, "json", rec.output, {
      fetchPrComments: () => comments({ reviewDecision: null }),
      fetchBranchProtection: () => zeroApprovalsProtection(),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(rec.lines[0]!);
    expect(parsed.gates.merge.dispositions.reviewGate).toBe("skipped");
    expect(parsed.gates.merge.ok).toBeTrue();
  });

  test("plain render distinguishes queued (waiting only) from blocked (hard)", () => {
    // GH-1354: a PR with CI in-flight + review pending shows `merge queued
    // (N waiting)`; a draft PR shows `merge blocked (N)`.
    const queued = recordingOutput();
    runInventory(target, "plain", queued.output, {
      fetchPrComments: () => comments({ reviewDecision: null, mergeStateStatus: "UNKNOWN" }),
      fetchBranchProtection: () => enforcedProtection(),
    });
    const queuedText = queued.lines.join("\n");
    expect(queuedText).toMatch(/gate merge\s+queued \(\d+ waiting\)/);

    const blocked = recordingOutput();
    runInventory(target, "plain", blocked.output, {
      fetchPrComments: () => comments({ isDraft: true }),
      fetchBranchProtection: () => enforcedProtection(),
    });
    const blockedText = blocked.lines.join("\n");
    expect(blockedText).toMatch(/gate merge\s+blocked \(\d+\)/);
  });

  test("json output partitions gates.merge into blockers + waiting arrays", () => {
    // GH-1354: wire-shape regression guard. Hard blockers and waiting items
    // surface separately so consumers can drive distinct UX.
    const rec = recordingOutput();
    const code = runInventory(target, "json", rec.output, {
      fetchPrComments: () =>
        comments({
          isDraft: true,
          reviewDecision: null,
          mergeStateStatus: "UNKNOWN",
        }),
      fetchBranchProtection: () => enforcedProtection(),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(rec.lines[0]!);
    expect(Array.isArray(parsed.gates.merge.blockers)).toBeTrue();
    expect(Array.isArray(parsed.gates.merge.waiting)).toBeTrue();
    expect(parsed.gates.merge.blockers.some((b: { predicate: string }) => b.predicate === "pr.isDraft=true")).toBeTrue();
    expect(parsed.gates.merge.waiting.some((b: { predicate: string }) => b.predicate.includes("review.decision="))).toBeTrue();
    expect(parsed.gates.merge.waiting.some((b: { predicate: string }) => b.predicate.includes("ci.state="))).toBeTrue();
    expect(parsed.gates.merge.ok).toBeFalse();
  });
});

// GH-1559 (GH-1398 ADR §4): the runMerge / runReady / runDraft transition
// suites moved to test/pr-state/publisher.test.ts alongside the verbs
// themselves. doctor.test.ts keeps loadInventory / gateTransition /
// runInventory — the read-only diagnosis surface that stayed on `doctor`.
