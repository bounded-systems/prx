import { describe, expect, test } from "bun:test";

import { parseArgs } from "@bounded-systems/verbspec";
import {
  protectMainVerb,
  type ProtectMainDeps,
  type ProtectMainOutput,
} from "../../src/pr-state/protect-main-verb.ts";

// `prx protect-main` migrated off cli.ts to a deps-bearing VerbSpec (ADR
// docs/prx/cli-decomposition.md). These drive the CLI path — parse (so repeated
// `--allow` flags accumulate) → run → render → exitCode — with the protection
// reads/writes injected. Routing (`repo protect-main`) is covered by the
// compiled CLI + help-all parity.

function protectMainBranchResultFixture(overrides: Record<string, unknown> = {}) {
  return {
    backend: "branch-protection" as const,
    repo: "bdelanghe/ai-home",
    branch: "main",
    viewer: "bdelanghe",
    owner: "bdelanghe",
    ownerType: "User",
    rulesetId: null,
    rulesetName: null,
    solo: false,
    apply: false,
    applied: false,
    approvalContributorCount: 1,
    requireLastPushApprovalSuppressed: false,
    requiredApprovingReviewCountSuppressed: false,
    enforceAdmins: false,
    requireConversationResolution: false,
    requireLastPushApproval: false,
    requiredApprovingReviewCount: 1,
    requireLinearHistory: false,
    requiredStatusChecks: [] as string[],
    payload: {
      required_status_checks: null,
      enforce_admins: null,
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        required_approving_review_count: 1,
        require_last_push_approval: false,
      },
      restrictions: null,
      required_linear_history: false,
      allow_force_pushes: false,
      allow_deletions: false,
      block_creations: false,
      required_conversation_resolution: false,
      lock_branch: false,
      allow_fork_syncing: false,
    },
    command: ["gh", "api", "--method", "PUT", "repos/bdelanghe/ai-home/branches/main/protection"],
    ...overrides,
  };
}

function checkMainBranchProtectionResultFixture(overrides: Record<string, unknown> = {}) {
  return {
    backend: "branch-protection" as const,
    repo: "bdelanghe/ai-home",
    branch: "main",
    viewer: "bdelanghe",
    owner: "bdelanghe",
    ownerType: "User",
    rulesetId: null,
    rulesetName: null,
    solo: false,
    approvalContributorCount: 1,
    requireLastPushApprovalSuppressed: false,
    requiredApprovingReviewCountSuppressed: false,
    enforceAdmins: false,
    requireConversationResolution: false,
    requireLastPushApproval: false,
    requiredApprovingReviewCount: 1,
    requireLinearHistory: false,
    requiredStatusChecks: [] as string[],
    desired: protectMainBranchResultFixture().payload,
    live: protectMainBranchResultFixture().payload,
    matches: true,
    ...overrides,
  };
}

type Captured = Array<Record<string, unknown>>;

// parse argv (verb subcommand args) → run → render → exitCode, like the CLI.
function runVerb(args: string[], deps: ProtectMainDeps): { rendered: string; exit: number } {
  const input = parseArgs(protectMainVerb as never, args) as Parameters<typeof protectMainVerb.run>[0];
  const out = protectMainVerb.run(input, deps) as ProtectMainOutput;
  return {
    rendered: protectMainVerb.render!(out, input as never),
    exit: protectMainVerb.exitCode!(out, input as never),
  };
}

const applyDeps = (fixture: unknown, calls?: Captured): ProtectMainDeps => ({
  checkMainBranchProtection: () => checkMainBranchProtectionResultFixture() as never,
  protectMainBranch: (_repoPath, options) => {
    calls?.push(options as unknown as Record<string, unknown>);
    return fixture as never;
  },
});

describe("protect-main verb", () => {
  test("apply dry-run plain output", () => {
    const { rendered, exit } = runVerb([], applyDeps(protectMainBranchResultFixture({
      requireConversationResolution: true,
      requiredStatusChecks: ["ci / test", "lint"],
      payload: {
        ...protectMainBranchResultFixture().payload,
        required_status_checks: { strict: true, contexts: ["ci / test", "lint"] },
        required_conversation_resolution: true,
      },
    })));
    expect(exit).toBe(0);
    expect(rendered).toContain("WOULD APPLY main protection");
    expect(rendered).toContain("backend=branch-protection");
    expect(rendered).toContain("repo=bdelanghe/ai-home");
    expect(rendered).toContain("require_conversation_resolution=true");
    expect(rendered).toContain("required_status_checks=ci / test,lint");
  });

  test("apply json output", () => {
    const { rendered, exit } = runVerb(
      ["--apply", "--format", "json"],
      applyDeps(protectMainBranchResultFixture({ apply: true, applied: true })),
    );
    expect(exit).toBe(0);
    expect(JSON.parse(rendered)).toMatchObject({ repo: "bdelanghe/ai-home", applied: true, branch: "main" });
  });

  test("--strict enables the full requirement set (apply=false)", () => {
    const calls: Captured = [];
    runVerb(["--strict"], applyDeps(protectMainBranchResultFixture(), calls));
    expect(calls[0]!).toMatchObject({
      apply: false,
      enforceAdmins: true,
      requireConversationResolution: true,
      requireLastPushApproval: true,
      requireLinearHistory: true,
    });
  });

  test("repeated deno-style --allow flags accumulate and map to requirements", () => {
    const calls: Captured = [];
    runVerb(
      ["--allow", "enforce-admins", "--allow", "status-check:ci"],
      applyDeps(protectMainBranchResultFixture({ enforceAdmins: true, requiredStatusChecks: ["ci"] }), calls),
    );
    expect(calls[0]!).toMatchObject({
      backend: "branch-protection",
      apply: false,
      enforceAdmins: true,
      requiredStatusChecks: ["ci"],
    });
  });

  test("--ruleset selects the ruleset backend", () => {
    const calls: Captured = [];
    runVerb(["--ruleset"], applyDeps(protectMainBranchResultFixture({ backend: "ruleset" }), calls));
    expect(calls[0]!).toMatchObject({ backend: "ruleset" });
  });

  test("--solo forwards", () => {
    const calls: Captured = [];
    runVerb(["--solo"], applyDeps(protectMainBranchResultFixture({ solo: true }), calls));
    expect(calls[0]!).toMatchObject({ solo: true });
  });

  test("--check renders drift and exits 1 on mismatch", () => {
    const { rendered, exit } = runVerb(["--check", "--enforce-admins"], {
      protectMainBranch: () => protectMainBranchResultFixture() as never,
      checkMainBranchProtection: () =>
        checkMainBranchProtectionResultFixture({
          enforceAdmins: true,
          desired: { ...protectMainBranchResultFixture().payload, enforce_admins: true },
          live: protectMainBranchResultFixture().payload,
          matches: false,
        }) as never,
    });
    expect(exit).toBe(1);
    expect(rendered).toContain("DRIFT main protection");
    expect(rendered).toContain("enforce_admins=true");
  });

  test("--check that matches exits 0", () => {
    const { exit } = runVerb(["--check"], {
      protectMainBranch: () => protectMainBranchResultFixture() as never,
      checkMainBranchProtection: () => checkMainBranchProtectionResultFixture({ matches: true }) as never,
    });
    expect(exit).toBe(0);
  });
});
