// publisher — the error/json arms and the gh-CLI verbs (pr open/update/comment/
// edit, issue update) the main publisher.test.ts leaves uncovered. Everything
// is driven through the loadInventory (fetchPrComments/fetchBranchProtection)
// and the per-mutation DI seams, plus a fake runner / execGhIssueEdit — no real
// gh / github GraphQL.

import { describe, expect, test } from "bun:test";

import type { AuditSinkDeps } from "../../src/audit/sink.ts";
import type { DoctorTarget } from "../../src/pr-state/doctor.ts";
import type { PrCommentsResult } from "../../src/pr-state/github.ts";
import {
  runDraft,
  runIssueUpdate,
  runMerge,
  runPrComment,
  runPrEdit,
  runPrOpen,
  runPrUpdate,
  runReady,
} from "../../src/pr-state/publisher.ts";

const target: DoctorTarget = { workUnitId: "GH-885", repoPath: "/repo" };
const silentAudit: AuditSinkDeps = { appendFn: () => {}, ensureDir: () => {} };
const enforcedProtection = () => ({ requiredApprovingReviewCount: 1, requireCodeOwnerReviews: false });

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

function rec() {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, output: { log: (l: string) => lines.push(l), error: (l: string) => errors.push(l) } };
}

const boom = () => {
  throw new Error("boom");
};
const okRunner = (stdout = "") => () => ({ stdout, stderr: "", status: 0 });
const failRunner = (stderr = "nope") => () => ({ stdout: "", stderr, status: 1 });

// ── runMerge error/json arms ────────────────────────────────────────────────

describe("runMerge — error & json arms", () => {
  test("first loadInventory failure → exit 1", () => {
    const r = rec();
    const code = runMerge(target, { method: "SQUASH" }, "plain", r.output, {
      fetchPrComments: boom,
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(r.errors.join("\n")).toContain("prx publisher merge:");
  });

  test("update-branch failure when behind → exit 1", () => {
    const r = rec();
    const code = runMerge(target, { method: "SQUASH" }, "plain", r.output, {
      fetchPrComments: () => comments({ mergeStateStatus: "BEHIND" }),
      fetchBranchProtection: enforcedProtection,
      runner: () => {
        throw new Error("update-branch exploded");
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(r.errors.join("\n")).toContain("gh pr update-branch failed");
  });

  test("reload after update-branch fails → exit 1", () => {
    const r = rec();
    let call = 0;
    const code = runMerge(target, { method: "SQUASH" }, "plain", r.output, {
      fetchPrComments: () => {
        call += 1;
        if (call === 1) return comments({ mergeStateStatus: "BEHIND" });
        throw new Error("reload failed");
      },
      fetchBranchProtection: enforcedProtection,
      runner: okRunner(),
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(call).toBe(2);
  });

  test("automerge already enabled + json → alreadyEnabled payload", () => {
    const r = rec();
    const code = runMerge(target, { method: "SQUASH" }, "json", r.output, {
      fetchPrComments: () =>
        comments({ autoMergeEnabled: true, autoMergeRequest: { enabledBy: "bot", mergeMethod: "SQUASH" } }),
      fetchBranchProtection: enforcedProtection,
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(JSON.parse(r.lines[0]!).alreadyEnabled).toBe(true);
  });

  test("resolvePrNodeId failure → exit 1", () => {
    const r = rec();
    const code = runMerge(target, { method: "SQUASH" }, "plain", r.output, {
      fetchPrComments: () => comments({ reviewDecision: null }),
      fetchBranchProtection: enforcedProtection,
      resolvePrNodeId: boom,
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(r.errors.join("\n")).toContain("could not resolve PR node id");
  });

  test("clean-status fallthrough but direct merge throws → exit 1", () => {
    const r = rec();
    const code = runMerge(target, { method: "SQUASH" }, "plain", r.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: enforcedProtection,
      resolvePrNodeId: () => "PR_NODE",
      enableAutoMerge: () => {
        throw new Error("Pull request is in clean status");
      },
      mergePullRequest: () => {
        throw new Error("direct merge failed");
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(r.errors.join("\n")).toContain("mergePullRequest failed");
  });
});

// ── runReady arms ───────────────────────────────────────────────────────────

describe("runReady — error & json arms", () => {
  test("loadInventory failure → exit 1", () => {
    const r = rec();
    expect(runReady(target, "plain", r.output, { fetchPrComments: boom, auditDeps: silentAudit })).toBe(1);
    expect(r.errors.join("\n")).toContain("prx publisher ready:");
  });

  test("already out of draft + json → alreadyReady payload", () => {
    const r = rec();
    const code = runReady(target, "json", r.output, {
      fetchPrComments: () => comments({ isDraft: false }),
      fetchBranchProtection: enforcedProtection,
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(JSON.parse(r.lines[0]!).alreadyReady).toBe(true);
  });

  test("resolvePrNodeId failure → exit 1", () => {
    const r = rec();
    const code = runReady(target, "plain", r.output, {
      fetchPrComments: () => comments({ isDraft: true }),
      fetchBranchProtection: enforcedProtection,
      resolvePrNodeId: boom,
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(r.errors.join("\n")).toContain("could not resolve PR node id");
  });

  test("markPrReadyForReview failure → exit 1", () => {
    const r = rec();
    const code = runReady(target, "plain", r.output, {
      fetchPrComments: () => comments({ isDraft: true }),
      fetchBranchProtection: enforcedProtection,
      resolvePrNodeId: () => "PR_NODE",
      markPrReadyForReview: boom,
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(r.errors.join("\n")).toContain("markPullRequestReadyForReview failed");
  });

  test("json success payload", () => {
    const r = rec();
    const code = runReady(target, "json", r.output, {
      fetchPrComments: () => comments({ isDraft: true }),
      fetchBranchProtection: enforcedProtection,
      resolvePrNodeId: () => "PR_NODE",
      markPrReadyForReview: () => ({ prNodeId: "PR_NODE", isDraft: false }),
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(JSON.parse(r.lines[0]!).isDraft).toBe(false);
  });
});

// ── runDraft arms ───────────────────────────────────────────────────────────

describe("runDraft — error & json arms", () => {
  test("loadInventory failure → exit 1", () => {
    const r = rec();
    expect(runDraft(target, "plain", r.output, { fetchPrComments: boom, auditDeps: silentAudit })).toBe(1);
    expect(r.errors.join("\n")).toContain("prx publisher draft:");
  });

  test("already draft + json → alreadyDraft payload", () => {
    const r = rec();
    const code = runDraft(target, "json", r.output, {
      fetchPrComments: () => comments({ isDraft: true }),
      fetchBranchProtection: enforcedProtection,
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(JSON.parse(r.lines[0]!).alreadyDraft).toBe(true);
  });

  test("resolvePrNodeId failure → exit 1", () => {
    const r = rec();
    const code = runDraft(target, "plain", r.output, {
      fetchPrComments: () => comments({ isDraft: false }),
      fetchBranchProtection: enforcedProtection,
      resolvePrNodeId: boom,
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(r.errors.join("\n")).toContain("could not resolve PR node id");
  });

  test("convertPrToDraft failure → exit 1", () => {
    const r = rec();
    const code = runDraft(target, "plain", r.output, {
      fetchPrComments: () => comments({ isDraft: false }),
      fetchBranchProtection: enforcedProtection,
      resolvePrNodeId: () => "PR_NODE",
      convertPrToDraft: boom,
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(r.errors.join("\n")).toContain("convertPullRequestToDraft failed");
  });

  test("json success payload", () => {
    const r = rec();
    const code = runDraft(target, "json", r.output, {
      fetchPrComments: () => comments({ isDraft: false }),
      fetchBranchProtection: enforcedProtection,
      resolvePrNodeId: () => "PR_NODE",
      convertPrToDraft: () => ({ prNodeId: "PR_NODE", isDraft: true }),
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(JSON.parse(r.lines[0]!).isDraft).toBe(true);
  });
});

// ── runPrOpen ───────────────────────────────────────────────────────────────

describe("runPrOpen", () => {
  test("gh pr create failure surfaces the status", () => {
    const r = rec();
    const code = runPrOpen(target, { summary: "feat: x" }, "plain", r.output, {
      runner: failRunner("denied"),
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(r.errors.join("\n")).toContain("gh pr create failed");
  });

  test("json success carries draft flag + url", () => {
    const r = rec();
    const code = runPrOpen(target, { summary: "feat: x", closes: ["GH-2"] }, "json", r.output, {
      runner: okRunner("https://github.com/owner/repo/pull/7"),
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    const payload = JSON.parse(r.lines[0]!);
    expect(payload.draft).toBe(true);
    expect(payload.prUrl).toContain("/pull/7");
  });

  test("plain ready open omits --draft", () => {
    const calls: string[][] = [];
    const r = rec();
    const code = runPrOpen(target, { summary: "feat: y", ready: true, base: "dev", head: "feat-y" }, "plain", r.output, {
      runner: (argv) => {
        calls.push(argv);
        return { stdout: "https://github.com/owner/repo/pull/8", stderr: "", status: 0 };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(calls[0]).not.toContain("--draft");
    expect(r.lines.join("\n")).toContain("opened ready PR");
  });
});

// ── runPrUpdate ─────────────────────────────────────────────────────────────

describe("runPrUpdate", () => {
  test("loadInventory failure → exit 1", () => {
    const r = rec();
    expect(runPrUpdate(target, {}, "plain", r.output, { fetchPrComments: boom, auditDeps: silentAudit })).toBe(1);
    expect(r.errors.join("\n")).toContain("prx publisher pr update:");
  });

  test("json success with retitle issues update-branch + edit", () => {
    const calls: string[][] = [];
    const r = rec();
    const code = runPrUpdate(target, { title: "feat: retitled" }, "json", r.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: enforcedProtection,
      runner: (argv) => {
        calls.push(argv);
        return { stdout: "", stderr: "", status: 0 };
      },
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(JSON.parse(r.lines[0]!).retitled).toBe(true);
    expect(calls.some((c) => c.includes("update-branch"))).toBe(true);
    expect(calls.some((c) => c.includes("edit"))).toBe(true);
  });

  test("plain success without retitle", () => {
    const r = rec();
    const code = runPrUpdate(target, {}, "plain", r.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: enforcedProtection,
      runner: okRunner(),
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(r.lines.join("\n")).toContain("prx publisher pr update: updated");
  });
});

// ── runPrComment ────────────────────────────────────────────────────────────

describe("runPrComment", () => {
  test("loadInventory failure → exit 1", () => {
    const r = rec();
    expect(
      runPrComment(target, { body: "hi" }, "plain", r.output, { fetchPrComments: boom, auditDeps: silentAudit }),
    ).toBe(1);
    expect(r.errors.join("\n")).toContain("prx publisher pr comment:");
  });

  test("gh pr comment failure surfaces the status", () => {
    const r = rec();
    const code = runPrComment(target, { body: "hi" }, "plain", r.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: enforcedProtection,
      runner: failRunner("rate limited"),
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(r.errors.join("\n")).toContain("gh pr comment failed");
  });

  test("json success", () => {
    const r = rec();
    const code = runPrComment(target, { body: "hi" }, "json", r.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: enforcedProtection,
      runner: okRunner(),
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(JSON.parse(r.lines[0]!).commented).toBe(true);
  });
});

// ── runPrEdit ───────────────────────────────────────────────────────────────

describe("runPrEdit", () => {
  test("loadInventory failure → exit 1", () => {
    const r = rec();
    expect(
      runPrEdit(target, { title: "t" }, "plain", r.output, { fetchPrComments: boom, auditDeps: silentAudit }),
    ).toBe(1);
    expect(r.errors.join("\n")).toContain("prx publisher pr edit:");
  });

  test("gh pr edit failure surfaces the status", () => {
    const r = rec();
    const code = runPrEdit(target, { title: "t", bodyFile: "/tmp/body.md" }, "plain", r.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: enforcedProtection,
      runner: failRunner("bad"),
      auditDeps: silentAudit,
    });
    expect(code).toBe(1);
    expect(r.errors.join("\n")).toContain("gh pr edit failed");
  });

  test("json success carries retitled + editedBody flags", () => {
    const r = rec();
    const code = runPrEdit(target, { title: "t", bodyFile: "/tmp/body.md" }, "json", r.output, {
      fetchPrComments: () => comments(),
      fetchBranchProtection: enforcedProtection,
      runner: okRunner(),
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    const payload = JSON.parse(r.lines[0]!);
    expect(payload.retitled).toBe(true);
    expect(payload.editedBody).toBe(true);
  });
});

// ── runIssueUpdate ──────────────────────────────────────────────────────────

describe("runIssueUpdate", () => {
  test("no fields to edit → already-in-sync (plain)", () => {
    const r = rec();
    const code = runIssueUpdate("GH-885", { number: 42 }, "plain", r.output, { auditDeps: silentAudit });
    expect(code).toBe(0);
    expect(r.lines.join("\n")).toContain("already in sync");
  });

  test("no fields to edit → edited:false (json)", () => {
    const r = rec();
    const code = runIssueUpdate("GH-885", { number: 42 }, "json", r.output, { auditDeps: silentAudit });
    expect(code).toBe(0);
    expect(JSON.parse(r.lines[0]!).edited).toBe(false);
  });

  test("execGhIssueEdit failure surfaces the exit code", () => {
    const r = rec();
    const code = runIssueUpdate("GH-885", { number: 42, title: "new" }, "plain", r.output, {
      execGhIssueEdit: () => ({ exitCode: 2, stdout: "", stderr: "gh down" }),
      auditDeps: silentAudit,
    });
    expect(code).toBe(2);
    expect(r.errors.join("\n")).toContain("gh issue edit failed");
  });

  test("successful edit emits the intent (plain)", () => {
    const r = rec();
    const code = runIssueUpdate(
      "GH-885",
      { number: 42, title: "new", body: "b", addLabels: ["x"], removeLabels: ["y"], addAssignees: ["a"], removeAssignees: ["b"], repo: "o/r" },
      "plain",
      r.output,
      { execGhIssueEdit: () => ({ exitCode: 0, stdout: "ok", stderr: "" }), auditDeps: silentAudit },
    );
    expect(code).toBe(0);
    expect(r.lines.join("\n")).toContain("edited GH-42");
  });

  test("successful edit → edited:true (json)", () => {
    const r = rec();
    const code = runIssueUpdate("GH-885", { number: 42, body: "b" }, "json", r.output, {
      execGhIssueEdit: () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      auditDeps: silentAudit,
    });
    expect(code).toBe(0);
    expect(JSON.parse(r.lines[0]!).edited).toBe(true);
  });
});
