/**
 * Session CLI contract tests.
 *
 * These test the JSON output contract of session commands (status, actions,
 * phase, snapshot) by injecting fixture data via deps — no git repo, no gh
 * auth, no filesystem side-effects.
 */
import { describe, expect, test } from "bun:test";
import { runCli as runCliDirect } from "../../src/pr-state/cli.ts";
import type { ActionPlan, ActionSnapshot } from "../../src/pr-state/actions.ts";
import type { DomainStateV1 } from "../../src/pr-state/domain_state.ts";
import type { BranchName, WorkUnitId } from "@bounded-systems/machine-schema";

// ── Fixtures ───────────────────────────────────────────────────────────

const rawStateFixture = {
  unitId: "GH-100" as WorkUnitId,
  artifacts: {
    ticket: { exists: false, id: null, system: "other" as const, url: null },
    worktree: { exists: true, path: "/tmp/test", checkedOutBranch: "GH-100" as BranchName, headSha: null },
    branch: { name: "GH-100" as BranchName, existsLocal: true, existsRemote: true, ahead: 0, behind: 0, headShaLocal: null, headShaRemote: null },
    pr: { exists: true, number: 100, state: "open" as const, isDraft: false, headRef: "GH-100" as BranchName, baseRef: null, url: "https://github.com/test/test/pull/100" },
  },
  signals: {
    review: { decision: "none" as const, reviewersRequested: false, unresolvedThreads: 0 },
    ci: { state: "passed" as const, requiredTotal: 1, requiredPassed: 1, failing: [] },
    mergeability: { state: "unknown" as const, blockedReasons: [] },
  },
  sync: { remoteFresh: true, ticketLinkedToPR: false },
  meta: { observedAt: "2026-01-01T00:00:00Z", sources: { git: "2026-01-01T00:00:00Z", gh: "2026-01-01T00:00:00Z", ticketSystem: null } },
};

const snapshotFixture: ActionSnapshot = {
  repoRoot: "/tmp/test",
  branch: "GH-100",
  contractExists: true,
  operation: "none",
  remoteFreshness: "fresh",
  local: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, conflicts: 0 },
  pr: { exists: true, number: 100, title: "Test PR", url: "https://github.com/test/test/pull/100", draft: false, checks: "green", review: "approved", approvals: 1, mergeable: "mergeable" },
  system: { lifecycle: "open", review: "approved", ci: "passed", mergeability: "clean" },
  mergeReady: true,
  phase: "ready_to_merge",
  currentUnit: null,
  rawState: rawStateFixture,
  invariants: { valid: true, findings: [] },
};

const actionFixture = {
  id: "merge",
  actor: "gh" as const,
  surface: "tool" as const,
  label: "Merge PR",
  reason: "All checks passed",
  command: "gh pr merge 100",
  priority: 1,
  enabled: true,
};

const actionPlanFixture: ActionPlan = {
  snapshot: snapshotFixture,
  actions: [actionFixture],
  next: actionFixture,
};

const domainStateFixture: DomainStateV1 = {
  kind: "DomainStateV1",
  ci: { verdict: "unchecked", freshness: "unknown" },
  taskContract: null,
  prState: {
    pr: snapshotFixture.pr,
    system: snapshotFixture.system,
    contract: { exists: true, mode: "ready", state: "merge_ready", title: "Test PR", reason: null },
    mergeReady: true,
  },
  workflowState: {
    phase: "ready_to_merge",
    task: { exists: false, currentRole: null, machineState: null, handoffStatus: null, blockers: [], nextRole: null },
  },
  repoState: {
    repoRoot: "/tmp/test",
    branch: "GH-100",
    operation: "none",
    remoteFreshness: "fresh",
    local: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, conflicts: 0 },
    currentUnit: null,
    artifacts: rawStateFixture.artifacts,
    sync: rawStateFixture.sync,
  },
  reviewState: {
    decision: "approved",
    reviewersRequested: false,
    unresolvedThreads: 0,
    approvals: 1,
    agentReview: null,
    humanReview: null,
    commentsResolved: null,
  },
  rawState: rawStateFixture,
  invariants: { valid: true, findings: [] },
};

// ── Helpers ────────────────────────────────────────────────────────────

function capture(argv: string[], deps = {}): { stdout: string; stderr: string; exitCode: number } {
  const logs: string[] = [];
  const errors: string[] = [];
  const result = runCliDirect(
    argv,
    { log: (l) => logs.push(l), error: (l) => errors.push(l) },
    { nextAction: () => actionPlanFixture, buildDomainState: () => domainStateFixture, ...deps },
  );
  if (result instanceof Promise) {
    throw new Error("capture() expected a sync runCli result but got a Promise");
  }
  return { stdout: logs.join("\n"), stderr: errors.join("\n"), exitCode: result };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("session contract (injected context)", () => {
  // GH-1166: invocations route through canonical top-level commands; the
  // describe labels are kept for behaviour-grouping clarity.
  describe("phase --format json (was: session status)", () => {
    test("returns phase and snapshot with correct shape", () => {
      const { stdout, exitCode } = capture(["phase", "--format", "json"]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty("phase");
      expect(parsed.phase).toBe("ready_to_merge");
    });
  });

  describe("actions --format json (was: session actions)", () => {
    test("returns actions array with correct shape", () => {
      const { stdout, exitCode } = capture(["actions", "--format", "json"]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty("actions");
      expect(Array.isArray(parsed.actions)).toBe(true);
      expect(parsed.actions.length).toBeGreaterThan(0);
      const action = parsed.actions[0];
      expect(action).toHaveProperty("id");
      expect(action).toHaveProperty("label");
      expect(action).toHaveProperty("command");
      expect(action).toHaveProperty("enabled");
      expect(action).toHaveProperty("priority");
    });

    test("includes snapshot in response", () => {
      const { stdout } = capture(["actions", "--format", "json"]);
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty("snapshot");
      expect(parsed.snapshot).toHaveProperty("branch");
      expect(parsed.snapshot).toHaveProperty("phase");
    });

    test("next action is first enabled action", () => {
      const { stdout } = capture(["actions", "--format", "json"]);
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty("next");
      expect(parsed.next).toHaveProperty("id");
      expect(parsed.next.enabled).toBe(true);
    });
  });

  describe("phase --format json (was: session phase)", () => {
    test("returns phase as string", () => {
      const { stdout, exitCode } = capture(["phase", "--format", "json"]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty("phase");
      expect(typeof parsed.phase).toBe("string");
    });
  });

  describe("snapshot --format json (was: session snapshot)", () => {
    test("returns domain state projection", () => {
      const { stdout, exitCode } = capture(["snapshot", "--format", "json"]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty("kind", "DomainStateV1");
      expect(parsed).toHaveProperty("prState");
      expect(parsed).toHaveProperty("workflowState");
      expect(parsed).toHaveProperty("repoState");
      expect(parsed).toHaveProperty("reviewState");
      expect(parsed).toHaveProperty("rawState");
      expect(parsed).toHaveProperty("invariants");
    });

    test("prState contains pr, system, contract, mergeReady", () => {
      const { stdout } = capture(["snapshot", "--format", "json"]);
      const parsed = JSON.parse(stdout);
      expect(parsed.prState).toHaveProperty("pr");
      expect(parsed.prState).toHaveProperty("system");
      expect(parsed.prState).toHaveProperty("contract");
      expect(parsed.prState).toHaveProperty("mergeReady");
    });

    test("repoState contains branch, local counts, artifacts", () => {
      const { stdout } = capture(["snapshot", "--format", "json"]);
      const parsed = JSON.parse(stdout);
      expect(parsed.repoState).toHaveProperty("branch", "GH-100");
      expect(parsed.repoState).toHaveProperty("local");
      expect(parsed.repoState.local).toHaveProperty("staged");
      expect(parsed.repoState.local).toHaveProperty("unstaged");
      expect(parsed.repoState.local).toHaveProperty("untracked");
      expect(parsed.repoState).toHaveProperty("artifacts");
    });

    test("rawState contains artifacts, signals, sync, meta", () => {
      const { stdout } = capture(["snapshot", "--format", "json"]);
      const parsed = JSON.parse(stdout);
      expect(parsed.rawState).toHaveProperty("artifacts");
      expect(parsed.rawState).toHaveProperty("signals");
      expect(parsed.rawState).toHaveProperty("sync");
      expect(parsed.rawState).toHaveProperty("meta");
    });

    test("invariants report valid/findings", () => {
      const { stdout } = capture(["snapshot", "--format", "json"]);
      const parsed = JSON.parse(stdout);
      expect(parsed.invariants).toHaveProperty("valid", true);
      expect(parsed.invariants).toHaveProperty("findings");
      expect(Array.isArray(parsed.invariants.findings)).toBe(true);
    });
  });

  describe("next-action --format json (was: session next-action)", () => {
    test("returns the next recommended action", () => {
      const { stdout, exitCode } = capture(["next-action", "--format", "json"]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty("next");
      expect(parsed.next).toHaveProperty("id", "merge");
      expect(parsed.next).toHaveProperty("command");
    });

    test("exit code 1 when no actions available", () => {
      const emptyPlan: ActionPlan = { ...actionPlanFixture, actions: [], next: null };
      const { exitCode } = capture(["next-action", "--format", "json"], { nextAction: () => emptyPlan });
      expect(exitCode).toBe(1);
    });
  });

  describe("plain format output", () => {
    test("actions --format plain produces human-readable text", () => {
      const { stdout, exitCode } = capture(["actions", "--format", "plain"]);
      expect(exitCode).toBe(0);
      expect(stdout.length).toBeGreaterThan(0);
      // Plain format should not be valid JSON
      expect(() => JSON.parse(stdout)).toThrow();
    });

    test("phase --format plain produces phase name", () => {
      const { stdout, exitCode } = capture(["phase", "--format", "plain"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("ready_to_merge");
    });
  });
});
