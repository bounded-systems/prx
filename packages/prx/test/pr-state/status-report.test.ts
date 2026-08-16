// pr-state/status-report — refreshTaskSignals (signal reconciliation) + renderStatus.
//
// refreshTaskSignals reads the worktree branch + live PR signals; the new
// StatusSignalsDeps seam lets us drive every reconciliation branch hermetically
// (no real git branch, no GitHub round-trip) against a real on-disk task
// contract fixture. renderStatus' mode/json projections are pure derives.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  refreshTaskSignals,
  renderStatus,
  type StatusSignalsDeps,
} from "../../src/pr-state/status-report.ts";
import { createTaskContract, defaultTaskPath, writeTaskContract } from "../../src/pr-state/task.ts";
import { writeContract } from "../../src/pr-state/contract.ts";
import type { PrSignalInfo, ReviewConfig } from "../../src/pr-state/github.ts";

const cleanups: string[] = [];
afterEach(() => {
  for (const p of cleanups.splice(0)) rmSync(p, { recursive: true, force: true });
});

// A worktree dir whose basename matches the canonical work-unit id (createTaskContract requires it).
function worktree(): string {
  const parent = mkdtempSync(join(tmpdir(), "status-report-"));
  cleanups.push(parent);
  const root = join(parent, "GH-339");
  mkdirSync(root, { recursive: true });
  return root;
}

function seededTask(): string {
  const root = worktree();
  writeTaskContract(
    defaultTaskPath(root),
    createTaskContract({ workUnitId: "GH-339", worktree: root, branch: "GH-339" }),
  );
  return defaultTaskPath(root);
}

// A review config that differs from the contract defaults (true/true/true/false)
// so the success-requirements patch fires.
const changedReviewConfig = (): ReviewConfig =>
  ({
    requireCommentsResolved: false,
    requireAgentReview: false,
    requireHumanReview: false,
    requireAutoMergeEnabled: true,
  }) as ReviewConfig;

const fullSignals = (over: Partial<PrSignalInfo> = {}): PrSignalInfo => ({
  reviewAdded: true,
  reviewApproved: true,
  agentReview: true,
  humanReview: true,
  commentsResolved: false, // contract default is true → change fires
  autoMergeEnabled: true,
  mergeStateStatus: "BEHIND", // → needsRebase
  mergeable: "CONFLICTING", // → mergeConflict
  ...over,
});

describe("refreshTaskSignals", () => {
  test("throws when the task contract is missing", () => {
    expect(() => refreshTaskSignals("/no/such/task.json")).toThrow(/task contract missing/);
  });

  test("reconciles every live PR signal onto the contract", () => {
    const taskPath = seededTask();
    const updated = refreshTaskSignals(taskPath, {
      loadReviewConfig: () => changedReviewConfig(),
      currentBranchName: () => "GH-339",
      fetchPrSignalInfo: () => fullSignals(),
    });
    expect(updated.success.requireAutoMergeEnabled).toBe(true);
    expect(updated.signals.reviewAdded).toBe(true);
    expect(updated.signals.reviewApproved).toBe(true);
    expect(updated.signals.agentReview).toBe(true);
    expect(updated.signals.humanReview).toBe(true);
    expect(updated.signals.commentsResolved).toBe(false);
    expect(updated.signals.autoMergeEnabled).toBe(true);
    expect(updated.signals.needsRebase).toBe(true);
    expect(updated.signals.mergeConflict).toBe(true);
  });

  test("persists the success patch then early-returns when the branch is unresolved", () => {
    const taskPath = seededTask();
    const updated = refreshTaskSignals(taskPath, {
      loadReviewConfig: () => changedReviewConfig(),
      currentBranchName: () => null, // no branch → early return after the success patch
      fetchPrSignalInfo: () => fullSignals(),
    });
    expect(updated.success.requireAutoMergeEnabled).toBe(true);
    // Signals untouched because we never reached the PR-signal block.
    expect(updated.signals.reviewAdded).toBe(false);
  });

  test("early-returns when there is no PR for the branch", () => {
    const taskPath = seededTask();
    const updated = refreshTaskSignals(taskPath, {
      loadReviewConfig: () => changedReviewConfig(),
      currentBranchName: () => "GH-339",
      fetchPrSignalInfo: () => null, // no PR → early return
    });
    expect(updated.success.requireAutoMergeEnabled).toBe(true);
    expect(updated.signals.reviewAdded).toBe(false);
  });

  test("is a no-op (no write) when nothing changed", () => {
    const taskPath = seededTask();
    // Review config matching the contract defaults + signals matching defaults.
    const matchingConfig = (): ReviewConfig =>
      ({
        requireCommentsResolved: true,
        requireAgentReview: true,
        requireHumanReview: true,
        requireAutoMergeEnabled: false,
      }) as ReviewConfig;
    const matchingSignals: PrSignalInfo = {
      reviewAdded: false,
      reviewApproved: false,
      agentReview: false,
      humanReview: false,
      commentsResolved: true,
      autoMergeEnabled: false,
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
    };
    const updated = refreshTaskSignals(taskPath, {
      loadReviewConfig: matchingConfig,
      currentBranchName: () => "GH-339",
      fetchPrSignalInfo: () => matchingSignals,
    });
    expect(updated.signals.reviewAdded).toBe(false);
    expect(updated.success.requireAutoMergeEnabled).toBe(false);
  });
});

describe("renderStatus", () => {
  function contractPath(): string {
    const root = worktree();
    const p = join(root, ".pr", "local", "pr.json");
    mkdirSync(join(root, ".pr", "local"), { recursive: true });
    writeContract(p, {
      pr: {
        title: "GH-339",
        lifecycle: { state: "merge_ready", reason: "Scope agreed" },
        ready: { value: true, reason: "Approved" },
      },
    });
    return p;
  }

  test("mode format returns the bare derived mode", () => {
    const out = renderStatus(contractPath(), "mode");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  test("json format returns the full derived-info JSON", () => {
    const out = renderStatus(contractPath(), "json");
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty("mode");
    expect(parsed).toHaveProperty("state");
  });

  test("plain format renders 'state (mode)[ - reason]' and refreshes the task contract", () => {
    const root = worktree();
    mkdirSync(join(root, ".pr", "local"), { recursive: true });
    const prPath = join(root, ".pr", "local", "pr.json");
    writeContract(prPath, {
      pr: {
        title: "GH-339",
        lifecycle: { state: "merge_ready", reason: "Scope agreed" },
        ready: { value: true, reason: "Approved" },
      },
    });
    // A task contract at the cwd-derived defaultTaskPath() makes the plain path
    // fire refreshTaskSignals; injected deps keep it off git/gh.
    writeTaskContract(
      defaultTaskPath(root),
      createTaskContract({ workUnitId: "GH-339", worktree: root, branch: "GH-339" }),
    );
    const deps: StatusSignalsDeps = {
      loadReviewConfig: () => changedReviewConfig(),
      currentBranchName: () => "GH-339",
      fetchPrSignalInfo: () => fullSignals(),
    };
    const prevCwd = process.cwd();
    process.chdir(root);
    try {
      const out = renderStatus(prPath, "plain", deps);
      expect(out).toMatch(/\(.+\)/); // "state (mode)"
    } finally {
      process.chdir(prevCwd);
    }
  });
});
