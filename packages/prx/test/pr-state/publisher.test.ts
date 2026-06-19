import { describe, expect, test } from "bun:test";

import type { AuditSinkDeps } from "../../src/audit/sink.ts";
import type { DoctorTarget } from "../../src/pr-state/doctor.ts";
import type { PrCommentsResult } from "../../src/pr-state/github.ts";
import {
  runDraft,
  runMerge,
  runPrComment,
  runPrEdit,
  runPrOpen,
  runPrUpdate,
  runReady,
} from "../../src/pr-state/publisher.ts";
import { runCli } from "../../src/pr-state/cli.ts";

const target: DoctorTarget = {
  workUnitId: "GH-885",
  repoPath: "/repo",
};

// The publisher transition verbs emit a `catalog-event` audit row through
// `recordEvent` on success (GH-1559). Tests that exercise the success path
// silence the sink so they never touch the real ~/.local/state NDJSON file.
const silentAudit: AuditSinkDeps = {
  appendFn: () => {},
  ensureDir: () => {},
};

function comments(overrides: Partial<PrCommentsResult["pr"]> = {}): PrCommentsResult {
  return {
    repoPath: "/repo",
    pr: {
      number: 100,
      title: "Publisher wires up automerge",
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

function recordingOutput(): {
  lines: string[];
  errors: string[];
  output: { log: (l: string) => void; error: (l: string) => void };
} {
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

describe("runMerge", () => {
  test("blockers cause non-zero exit and print fix hints", () => {
    const rec = recordingOutput();
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () => comments({ isDraft: true }),
      fetchBranchProtection: () => enforcedProtection(),
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(rec.errors.join("\n")).toContain("pr.isDraft=true");
    expect(rec.errors.join("\n")).toContain("prx publisher ready");
  });

  test("queues automerge with review listed as waiting when protection enforces approvals", () => {
    // GH-1354: review.decision != APPROVED on an enforced branch is a waiting
    // condition, not a veto. Publisher enables automerge and surfaces the
    // waiting predicate in plain output.
    const rec = recordingOutput();
    let enableCalled = false;
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () => comments({ reviewDecision: null }),
      fetchBranchProtection: () => enforcedProtection(),
      resolvePrNodeId: () => "PR_NODE_100",
      enableAutoMerge: (_repo, prNodeId, mergeMethod) => {
        enableCalled = true;
        return { prNodeId, mergeMethod };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(enableCalled).toBeTrue();
    const plain = rec.lines.join("\n");
    expect(plain).toContain("waiting on:");
    expect(plain).toContain("signals.review.decision=none");
  });

  test("queues automerge when CI is in_progress (BLOCKED + threads=0 still passes)", () => {
    // GH-1354: in-flight CI is a waiting condition. Note: BLOCKED with no
    // unresolved threads collapses to ciState=failed in projectInventory, so
    // we use a status that yields ciState=in_progress directly.
    const rec = recordingOutput();
    let enableCalled = false;
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () => comments({ mergeStateStatus: "UNKNOWN" }),
      fetchBranchProtection: () => enforcedProtection(),
      resolvePrNodeId: () => "PR_NODE_100",
      enableAutoMerge: (_repo, prNodeId, mergeMethod) => {
        enableCalled = true;
        return { prNodeId, mergeMethod };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(enableCalled).toBeTrue();
    expect(rec.lines.join("\n")).toContain("waiting on: ci");
  });

  test("queues automerge when mergeability is UNKNOWN", () => {
    const rec = recordingOutput();
    let enableCalled = false;
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () => comments({ mergeable: "UNKNOWN" }),
      fetchBranchProtection: () => enforcedProtection(),
      resolvePrNodeId: () => "PR_NODE_100",
      enableAutoMerge: (_repo, prNodeId, mergeMethod) => {
        enableCalled = true;
        return { prNodeId, mergeMethod };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(enableCalled).toBeTrue();
    expect(rec.lines.join("\n")).toContain("waiting on: mergeability");
  });

  test("queues automerge with multiple waiting conditions (ci + review + mergeability)", () => {
    const rec = recordingOutput();
    let enableCalled = false;
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () =>
        comments({
          reviewDecision: null,
          mergeStateStatus: "UNKNOWN",
          mergeable: "UNKNOWN",
        }),
      fetchBranchProtection: () => enforcedProtection(),
      resolvePrNodeId: () => "PR_NODE_100",
      enableAutoMerge: (_repo, prNodeId, mergeMethod) => {
        enableCalled = true;
        return { prNodeId, mergeMethod };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(enableCalled).toBeTrue();
    const plain = rec.lines.join("\n");
    expect(plain).toContain("waiting on:");
    expect(plain).toContain("ci");
    expect(plain).toContain("review");
    expect(plain).toContain("mergeability");
  });

  test("hard-blocks on failed CI (mergeStateStatus=DIRTY)", () => {
    const rec = recordingOutput();
    let enableCalled = false;
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () => comments({ mergeStateStatus: "DIRTY" }),
      fetchBranchProtection: () => enforcedProtection(),
      enableAutoMerge: () => {
        enableCalled = true;
        return { prNodeId: "x", mergeMethod: "SQUASH" };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(enableCalled).toBeFalse();
    expect(rec.errors.join("\n")).toContain("signals.ci.state=failed");
  });

  test("hard-blocks on conflicting mergeability", () => {
    const rec = recordingOutput();
    let enableCalled = false;
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () => comments({ mergeable: "CONFLICTING" }),
      fetchBranchProtection: () => enforcedProtection(),
      enableAutoMerge: () => {
        enableCalled = true;
        return { prNodeId: "x", mergeMethod: "SQUASH" };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(enableCalled).toBeFalse();
    expect(rec.errors.join("\n")).toContain("signals.mergeability.state=CONFLICTING");
  });

  test("hard-blocks on unresolved threads (operator must resolve first)", () => {
    const rec = recordingOutput();
    let enableCalled = false;
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () => ({
        ...comments(),
        unresolvedThreads: 2,
      }),
      fetchBranchProtection: () => enforcedProtection(),
      enableAutoMerge: () => {
        enableCalled = true;
        return { prNodeId: "x", mergeMethod: "SQUASH" };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(enableCalled).toBeFalse();
    const errs = rec.errors.join("\n");
    expect(errs).toContain("blocker(s)");
    expect(errs).toContain("signals.review.unresolvedThreads=2");
  });

  test("--format json on the queue path includes waiting predicates", () => {
    const rec = recordingOutput();
    const code = runMerge(target, { method: "SQUASH" }, "json", rec.output, {
      fetchPrComments: () => comments({ reviewDecision: null, mergeable: "UNKNOWN" }),
      fetchBranchProtection: () => enforcedProtection(),
      resolvePrNodeId: () => "PR_NODE_100",
      enableAutoMerge: (_repo, prNodeId, mergeMethod) => ({ prNodeId, mergeMethod }),
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(rec.lines[0]!);
    expect(parsed.path).toBe("automerge");
    expect(Array.isArray(parsed.waiting)).toBeTrue();
    expect(parsed.waiting.some((p: string) => p.includes("review.decision="))).toBeTrue();
    expect(parsed.waiting.some((p: string) => p.includes("mergeability.state=UNKNOWN"))).toBeTrue();
  });

  test("lands a 0-approvals PR by enabling automerge without an APPROVED review", () => {
    const rec = recordingOutput();
    let enableCalled = false;
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () => comments({ reviewDecision: null }),
      fetchBranchProtection: () => zeroApprovalsProtection(),
      resolvePrNodeId: () => "PR_NODE_100",
      enableAutoMerge: (_repo, prNodeId, mergeMethod) => {
        enableCalled = true;
        return { prNodeId, mergeMethod };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(enableCalled).toBeTrue();
    expect(rec.lines.join("\n")).toContain("automerge enabled");
  });

  test("auto-runs gh pr update-branch when behind, then enables automerge", () => {
    let inventoryCall = 0;
    const runnerCalls: string[][] = [];
    const rec = recordingOutput();
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () => {
        inventoryCall += 1;
        if (inventoryCall === 1) {
          // First load: behind base.
          return comments({ mergeStateStatus: "BEHIND" });
        }
        return comments();
      },
      fetchBranchProtection: () => enforcedProtection(),
      runner: (cmd, _opts) => {
        runnerCalls.push(cmd);
        return { stdout: "", stderr: "", status: 0 };
      },
      resolvePrNodeId: () => "PR_NODE_100",
      enableAutoMerge: (_repo, prNodeId, mergeMethod) => ({
        prNodeId,
        mergeMethod,
      }),
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(
      runnerCalls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "update-branch"),
    ).toBeTrue();
    expect(rec.lines.join("\n")).toContain("automerge enabled");
    expect(inventoryCall).toBe(2);
  });

  test("--no-update-branch skips the auto-update retry and surfaces the blocker", () => {
    const rec = recordingOutput();
    const runnerCalls: string[][] = [];
    const code = runMerge(target, { method: "SQUASH", noUpdateBranch: true }, "plain", rec.output, {
      fetchPrComments: () => comments({ mergeStateStatus: "BEHIND" }),
      fetchBranchProtection: () => enforcedProtection(),
      runner: (cmd) => {
        runnerCalls.push(cmd);
        return { stdout: "", stderr: "", status: 0 };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(
      runnerCalls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "update-branch"),
    ).toBeFalse();
    expect(rec.errors.join("\n")).toContain("remoteFresh");
  });

  test("no-op when automerge is already enabled", () => {
    const rec = recordingOutput();
    let enableCalled = false;
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () =>
        comments({
          autoMergeEnabled: true,
          autoMergeRequest: { enabledBy: "operator", mergeMethod: "SQUASH" },
        }),
      fetchBranchProtection: () => enforcedProtection(),
      enableAutoMerge: () => {
        enableCalled = true;
        return { prNodeId: "x", mergeMethod: "SQUASH" };
      },
      resolvePrNodeId: () => "x",
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(enableCalled).toBeFalse();
    expect(rec.lines.join("\n")).toContain("already enabled");
  });

  test("falls back to direct merge when enableAutoMerge errors with clean-status", () => {
    const rec = recordingOutput();
    let mergeCalled = false;
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: () => enforcedProtection(),
      resolvePrNodeId: () => "PR_NODE_100",
      enableAutoMerge: () => {
        throw new Error("Pull request Pull request is in clean status");
      },
      mergePullRequest: (_repo, prNodeId, _method) => {
        mergeCalled = true;
        return { prNodeId, merged: true, state: "MERGED" };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(mergeCalled).toBeTrue();
    expect(rec.lines.join("\n")).toContain("falling through to direct merge");
    expect(rec.lines.join("\n")).toContain("merged https://github.com/owner/repo/pull/100");
  });

  test("surfaces non-clean enableAutoMerge errors as failures without invoking direct merge", () => {
    const rec = recordingOutput();
    let mergeCalled = false;
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: () => enforcedProtection(),
      resolvePrNodeId: () => "PR_NODE_100",
      enableAutoMerge: () => {
        throw new Error("HTTP 502 Bad Gateway");
      },
      mergePullRequest: () => {
        mergeCalled = true;
        return { prNodeId: "x", merged: true, state: "MERGED" };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(mergeCalled).toBeFalse();
    expect(rec.errors.join("\n")).toContain(
      "enablePullRequestAutoMerge failed: HTTP 502 Bad Gateway",
    );
  });

  test("--format json includes path=automerge on the queue path", () => {
    const rec = recordingOutput();
    const code = runMerge(target, { method: "SQUASH" }, "json", rec.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: () => enforcedProtection(),
      resolvePrNodeId: () => "PR_NODE_100",
      enableAutoMerge: (_repo, prNodeId, mergeMethod) => ({ prNodeId, mergeMethod }),
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(rec.lines[0]!);
    expect(parsed.path).toBe("automerge");
    expect(parsed.method).toBe("SQUASH");
    expect(parsed.prNodeId).toBe("PR_NODE_100");
  });

  test("--format json includes path=direct on the fallback path", () => {
    const rec = recordingOutput();
    const code = runMerge(target, { method: "SQUASH" }, "json", rec.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: () => enforcedProtection(),
      resolvePrNodeId: () => "PR_NODE_100",
      enableAutoMerge: () => {
        throw new Error("Pull request is in clean status");
      },
      mergePullRequest: (_repo, prNodeId) => ({ prNodeId, merged: true, state: "MERGED" }),
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(rec.lines[0]!);
    expect(parsed.path).toBe("direct");
    expect(parsed.method).toBe("SQUASH");
    expect(parsed.prNodeId).toBe("PR_NODE_100");
  });

  // GH-2249 (I-PROV1): an injected "unsigned" provenance verdict hard-blocks
  // the merge before automerge is enabled (fail closed).
  test("blocks on an unsigned provenance verdict", () => {
    const rec = recordingOutput();
    let enableCalled = false;
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: () => enforcedProtection(),
      enableAutoMerge: () => {
        enableCalled = true;
        return { prNodeId: "x", mergeMethod: "SQUASH" };
      },
      provenanceAxis: "unsigned",
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(enableCalled).toBeFalse();
    expect(rec.errors.join("\n")).toContain("provenance.signed=unsigned");
  });

  test("a verified provenance verdict does not block the merge", () => {
    const rec = recordingOutput();
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: () => enforcedProtection(),
      enableAutoMerge: () => ({ prNodeId: "x", mergeMethod: "SQUASH" }),
      resolvePrNodeId: () => "x",
      provenanceAxis: "verified",
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(rec.errors.join("\n")).not.toContain("provenance");
  });
});

describe("runReady", () => {
  test("calls markPullRequestReadyForReview when draft and gate passes", () => {
    const rec = recordingOutput();
    let markCalled = false;
    const code = runReady(target, "plain", rec.output, {
      fetchPrComments: () => comments({ isDraft: true }),
      fetchBranchProtection: () => enforcedProtection(),
      resolvePrNodeId: () => "PR_NODE",
      markPrReadyForReview: () => {
        markCalled = true;
        return { prNodeId: "PR_NODE", isDraft: false };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(markCalled).toBeTrue();
  });

  test("blocks when CI is failing", () => {
    const rec = recordingOutput();
    const code = runReady(target, "plain", rec.output, {
      fetchPrComments: () => comments({ isDraft: true, mergeStateStatus: "DIRTY" }),
      fetchBranchProtection: () => enforcedProtection(),
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(rec.errors.join("\n")).toContain("ci.state=failed");
  });

  test("no-op when PR is already ready", () => {
    const rec = recordingOutput();
    let markCalled = false;
    const code = runReady(target, "plain", rec.output, {
      fetchPrComments: () => comments({ isDraft: false }),
      fetchBranchProtection: () => enforcedProtection(),
      markPrReadyForReview: () => {
        markCalled = true;
        return { prNodeId: "x", isDraft: false };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(markCalled).toBeFalse();
  });

  // GH-2249 (I-PROV1): an injected "unsigned" verdict blocks ready promotion.
  test("blocks promotion to ready on an unsigned provenance verdict", () => {
    const rec = recordingOutput();
    let markCalled = false;
    const code = runReady(target, "plain", rec.output, {
      fetchPrComments: () => comments({ isDraft: true }),
      fetchBranchProtection: () => enforcedProtection(),
      markPrReadyForReview: () => {
        markCalled = true;
        return { prNodeId: "x", isDraft: false };
      },
      provenanceAxis: "unsigned",
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(markCalled).toBeFalse();
    expect(rec.errors.join("\n")).toContain("provenance.signed=unsigned");
  });
});

describe("runDraft", () => {
  test("calls convertPullRequestToDraft when not draft (no gate)", () => {
    const rec = recordingOutput();
    let convertCalled = false;
    const code = runDraft(target, "plain", rec.output, {
      fetchPrComments: () => comments({ isDraft: false }),
      fetchBranchProtection: () => enforcedProtection(),
      resolvePrNodeId: () => "PR_NODE",
      convertPrToDraft: () => {
        convertCalled = true;
        return { prNodeId: "PR_NODE", isDraft: true };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(convertCalled).toBeTrue();
  });

  test("no-op when PR is already draft", () => {
    const rec = recordingOutput();
    let convertCalled = false;
    const code = runDraft(target, "plain", rec.output, {
      fetchPrComments: () => comments({ isDraft: true }),
      fetchBranchProtection: () => enforcedProtection(),
      convertPrToDraft: () => {
        convertCalled = true;
        return { prNodeId: "x", isDraft: true };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(convertCalled).toBeFalse();
  });
});

describe("publisher intent events (GH-1559)", () => {
  // The three transition verbs emit their publisher-owned intent through
  // `recordEvent`; eventOwnerMap attributes the row to `publisher` and stamps
  // the workUnitId. We capture the sink to assert the emission shape.
  function capturingAudit(): { rows: Array<Record<string, unknown>>; deps: AuditSinkDeps } {
    const rows: Array<Record<string, unknown>> = [];
    return {
      rows,
      deps: {
        appendFn: (_path, line) => rows.push(JSON.parse(line)),
        ensureDir: () => {},
      },
    };
  }

  test("merge emits PR_AUTOMERGE_REQUESTED attributed to publisher", () => {
    const rec = recordingOutput();
    const audit = capturingAudit();
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: () => enforcedProtection(),
      resolvePrNodeId: () => "PR_NODE_100",
      enableAutoMerge: (_repo, prNodeId, mergeMethod) => ({ prNodeId, mergeMethod }),
      auditDeps: audit.deps,
    });
    expect(code).toBe(0);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      kind: "catalog-event",
      event: "PR_AUTOMERGE_REQUESTED",
      actor: "publisher",
      workUnitId: "GH-885",
    });
  });

  test("ready emits PR_READY_REQUESTED attributed to publisher", () => {
    const rec = recordingOutput();
    const audit = capturingAudit();
    const code = runReady(target, "plain", rec.output, {
      fetchPrComments: () => comments({ isDraft: true }),
      fetchBranchProtection: () => enforcedProtection(),
      resolvePrNodeId: () => "PR_NODE",
      markPrReadyForReview: () => ({ prNodeId: "PR_NODE", isDraft: false }),
      auditDeps: audit.deps,
    });
    expect(code).toBe(0);
    expect(audit.rows[0]).toMatchObject({
      kind: "catalog-event",
      event: "PR_READY_REQUESTED",
      actor: "publisher",
      workUnitId: "GH-885",
    });
  });

  test("draft emits PR_DRAFT_REQUESTED attributed to publisher", () => {
    const rec = recordingOutput();
    const audit = capturingAudit();
    const code = runDraft(target, "plain", rec.output, {
      fetchPrComments: () => comments({ isDraft: false }),
      fetchBranchProtection: () => enforcedProtection(),
      resolvePrNodeId: () => "PR_NODE",
      convertPrToDraft: () => ({ prNodeId: "PR_NODE", isDraft: true }),
      auditDeps: audit.deps,
    });
    expect(code).toBe(0);
    expect(audit.rows[0]).toMatchObject({
      kind: "catalog-event",
      event: "PR_DRAFT_REQUESTED",
      actor: "publisher",
      workUnitId: "GH-885",
    });
  });

  test("a blocked merge does not emit an intent event", () => {
    const rec = recordingOutput();
    const audit = capturingAudit();
    const code = runMerge(target, { method: "SQUASH" }, "plain", rec.output, {
      fetchPrComments: () => comments({ isDraft: true }),
      fetchBranchProtection: () => enforcedProtection(),
      auditDeps: audit.deps,
    });
    expect(code).toBe(1);
    expect(audit.rows).toHaveLength(0);
  });
});

describe("prx doctor merge|ready|draft deprecation aliases (GH-1559)", () => {
  // The doctor verbs delegate to the publisher handler after printing a
  // one-line deprecation notice to stderr; stdout/JSON stays clean.
  test("prx doctor merge prints a stderr notice and invokes the publisher handler", async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    let handlerCalled = false;
    const code = await runCli(
      ["doctor", "merge", "GH-885"],
      { log: (l) => lines.push(l), error: (l) => errors.push(l) },
      {
        runPublisherMerge: (t, _opts, _format, out) => {
          handlerCalled = true;
          out.log(`merged ${t.workUnitId}`);
          return 0;
        },
      },
    );
    expect(code).toBe(0);
    expect(handlerCalled).toBeTrue();
    expect(errors.join("\n")).toContain(
      "prx doctor merge is deprecated; use `prx publisher merge`",
    );
    // The delegated handler's stdout is untouched by the notice.
    expect(lines.join("\n")).toContain("merged GH-885");
  });

  test("prx doctor ready delegates to the publisher ready handler", async () => {
    const errors: string[] = [];
    let handlerCalled = false;
    const code = await runCli(
      ["doctor", "ready", "GH-885"],
      { log: () => {}, error: (l) => errors.push(l) },
      {
        runPublisherReady: () => {
          handlerCalled = true;
          return 0;
        },
      },
    );
    expect(code).toBe(0);
    expect(handlerCalled).toBeTrue();
    expect(errors.join("\n")).toContain(
      "prx doctor ready is deprecated; use `prx publisher ready`",
    );
  });

  test("prx doctor draft delegates to the publisher draft handler", async () => {
    const errors: string[] = [];
    let handlerCalled = false;
    const code = await runCli(
      ["doctor", "draft", "GH-885"],
      { log: () => {}, error: (l) => errors.push(l) },
      {
        runPublisherDraft: () => {
          handlerCalled = true;
          return 0;
        },
      },
    );
    expect(code).toBe(0);
    expect(handlerCalled).toBeTrue();
    expect(errors.join("\n")).toContain(
      "prx doctor draft is deprecated; use `prx publisher draft`",
    );
  });

  test("prx publisher merge routes directly to the publisher handler (no notice)", async () => {
    const errors: string[] = [];
    let handlerCalled = false;
    const code = await runCli(
      ["publisher", "merge", "GH-885"],
      { log: () => {}, error: (l) => errors.push(l) },
      {
        runPublisherMerge: () => {
          handlerCalled = true;
          return 0;
        },
      },
    );
    expect(code).toBe(0);
    expect(handlerCalled).toBeTrue();
    expect(errors.join("\n")).not.toContain("deprecated");
  });
});

describe("runPrOpen (GH-1560)", () => {
  const okRunner = (calls: string[][]) => (cmd: string[]) => {
    calls.push(cmd);
    return { stdout: "https://github.com/owner/repo/pull/123", stderr: "", status: 0 };
  };

  test("opens a draft PR by default — (GH-N) title + Closes #N body", () => {
    const rec = recordingOutput();
    const calls: string[][] = [];
    const code = runPrOpen(target, { summary: "feat(x): thing" }, "plain", rec.output, {
      runner: okRunner(calls),
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    const create = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create");
    expect(create).toBeDefined();
    expect(create!).toContain("--draft");
    expect(create![create!.indexOf("--title") + 1]).toBe("feat(x): thing (GH-885)");
    expect(create![create!.indexOf("--body") + 1]).toContain("Closes #885");
    expect(create![create!.indexOf("--base") + 1]).toBe("main");
    expect(create![create!.indexOf("--head") + 1]).toBe("GH-885");
  });

  test("--ready opens ready-for-review (no --draft)", () => {
    const rec = recordingOutput();
    const calls: string[][] = [];
    const code = runPrOpen(
      target,
      { summary: "feat(x): thing", ready: true },
      "plain",
      rec.output,
      { runner: okRunner(calls), auditDeps: silentAudit },
    );
    expect(code).toBe(0);
    const create = calls.find((c) => c[2] === "create");
    expect(create!).not.toContain("--draft");
  });

  test("extra --closes units appear in the body", () => {
    const rec = recordingOutput();
    const calls: string[][] = [];
    runPrOpen(target, { summary: "feat: x", closes: ["GH-900"] }, "plain", rec.output, {
      runner: okRunner(calls),
      auditDeps: silentAudit,
    });
    const create = calls.find((c) => c[2] === "create");
    const body = create![create!.indexOf("--body") + 1]!;
    expect(body).toContain("Closes #885");
    expect(body).toContain("Closes #900");
  });
});

describe("runPrUpdate (GH-1560)", () => {
  const captureRunner = (calls: string[][]) => (cmd: string[]) => {
    calls.push(cmd);
    return { stdout: "", stderr: "", status: 0 };
  };

  test("update-branch + retitle invoke gh (title gets the (GH-N) contract)", () => {
    const rec = recordingOutput();
    const calls: string[][] = [];
    const code = runPrUpdate(target, { title: "feat(x): renamed" }, "plain", rec.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: () => enforcedProtection(),
      runner: captureRunner(calls),
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(
      calls.some(
        (c) => c[0] === "gh" && c[1] === "pr" && c[2] === "update-branch" && c[3] === "100",
      ),
    ).toBe(true);
    const edit = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "edit");
    expect(edit).toBeDefined();
    expect(edit![edit!.indexOf("--title") + 1]).toBe("feat(x): renamed (GH-885)");
  });

  test("without --title, only update-branch runs (no retitle)", () => {
    const rec = recordingOutput();
    const calls: string[][] = [];
    runPrUpdate(target, {}, "plain", rec.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: () => enforcedProtection(),
      runner: captureRunner(calls),
      auditDeps: silentAudit,
    });
    expect(calls.some((c) => c[2] === "update-branch")).toBe(true);
    expect(calls.some((c) => c[2] === "edit")).toBe(false);
  });
});

describe("runPrComment (ai-home-2ow2v)", () => {
  const captureRunner = (calls: string[][]) => (cmd: string[]) => {
    calls.push(cmd);
    return { stdout: "", stderr: "", status: 0 };
  };
  const inventoryDeps = (calls: string[][]) => ({
    fetchPrComments: () => comments(),
    fetchBranchProtection: () => enforcedProtection(),
    runner: captureRunner(calls),
    auditDeps: silentAudit,
  });

  test("posts a comment via gh pr comment on the resolved PR number", () => {
    const rec = recordingOutput();
    const calls: string[][] = [];
    const code = runPrComment(
      target,
      { body: "rebased onto main" },
      "plain",
      rec.output,
      inventoryDeps(calls),
    );
    expect(code).toBe(0);
    const c = calls.find((x) => x[0] === "gh" && x[1] === "pr" && x[2] === "comment");
    expect(c).toBeDefined();
    expect(c![3]).toBe("100");
    expect(c![c!.indexOf("--body") + 1]).toBe("rebased onto main");
  });

  test("propagates a nonzero gh exit code", () => {
    const rec = recordingOutput();
    const code = runPrComment(target, { body: "x" }, "plain", rec.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: () => enforcedProtection(),
      runner: () => ({ stdout: "", stderr: "boom", status: 1 }),
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
  });
});

describe("runPrEdit (ai-home-2ow2v)", () => {
  const captureRunner = (calls: string[][]) => (cmd: string[]) => {
    calls.push(cmd);
    return { stdout: "", stderr: "", status: 0 };
  };
  const inventoryDeps = (calls: string[][]) => ({
    fetchPrComments: () => comments(),
    fetchBranchProtection: () => enforcedProtection(),
    runner: captureRunner(calls),
    auditDeps: silentAudit,
  });

  test("edits title (with (GH-N) contract) and body-file via gh pr edit", () => {
    const rec = recordingOutput();
    const calls: string[][] = [];
    const code = runPrEdit(
      target,
      { title: "feat(x): renamed", bodyFile: "/tmp/body.md" },
      "plain",
      rec.output,
      inventoryDeps(calls),
    );
    expect(code).toBe(0);
    const edit = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "edit");
    expect(edit).toBeDefined();
    expect(edit![3]).toBe("100");
    expect(edit![edit!.indexOf("--title") + 1]).toBe("feat(x): renamed (GH-885)");
    expect(edit![edit!.indexOf("--body-file") + 1]).toBe("/tmp/body.md");
  });

  test("body-file only — no --title flag", () => {
    const rec = recordingOutput();
    const calls: string[][] = [];
    runPrEdit(target, { bodyFile: "/tmp/b.md" }, "plain", rec.output, inventoryDeps(calls));
    const edit = calls.find((c) => c[2] === "edit");
    expect(edit!).not.toContain("--title");
    expect(edit![edit!.indexOf("--body-file") + 1]).toBe("/tmp/b.md");
  });
});
