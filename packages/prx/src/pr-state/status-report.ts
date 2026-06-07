// Shared status/task-signal helpers extracted from pr-state/cli.ts — a Stage-0
// leaf of the §4 cli.ts decomposition (ADR docs/prx/cli-decomposition.md). These
// were cli.ts-local but depend only on leaf modules (task / github / contract),
// so peeling them out unblocks the `status` / `transition` handlers from
// migrating to VerbSpecs without a cli.ts import cycle. Pure move — no behavior
// change.

import type { Output } from "./cli-types.ts";
import { deriveInfo, loadContract } from "./contract.ts";
import { currentBranchName, fetchPrSignalInfo, loadReviewConfig } from "./github.ts";
import {
  defaultTaskPath,
  loadTaskContract,
  setTaskAgentReview,
  setTaskAutoMergeEnabled,
  setTaskCommentsResolved,
  setTaskHumanReview,
  setTaskMergeConflict,
  setTaskNeedsRebase,
  setTaskReviewAdded,
  setTaskReviewApproved,
  setTaskSuccessRequirements,
  taskContractExists,
  writeTaskContract,
  type TaskContract,
} from "./task.ts";

/**
 * Reconcile a task contract's review-config requirements and live PR signals
 * (review/approval/comments/auto-merge/rebase/conflict), persisting only when a
 * field actually changed. Returns the (possibly updated) contract.
 */
export function refreshTaskSignals(taskPath: string): TaskContract {
  if (!taskContractExists(taskPath)) {
    throw new Error(`task contract missing at ${taskPath}`);
  }

  let updated = loadTaskContract(taskPath);
  let dirty = false;

  const reviewConfig = loadReviewConfig(updated.identity.worktree);
  const successPatch = {
    requireCommentsResolved: reviewConfig.requireCommentsResolved,
    requireAgentReview: reviewConfig.requireAgentReview,
    requireHumanReview: reviewConfig.requireHumanReview,
    requireAutoMergeEnabled: reviewConfig.requireAutoMergeEnabled,
  };
  const successUpdated =
    updated.success.requireCommentsResolved !== successPatch.requireCommentsResolved ||
    updated.success.requireAgentReview !== successPatch.requireAgentReview ||
    updated.success.requireHumanReview !== successPatch.requireHumanReview ||
    updated.success.requireAutoMergeEnabled !== successPatch.requireAutoMergeEnabled;
  if (successUpdated) {
    updated = setTaskSuccessRequirements(updated, successPatch);
    dirty = true;
  }

  const branch = currentBranchName(updated.identity.worktree);
  if (!branch) {
    if (dirty) {
      writeTaskContract(taskPath, updated);
    }
    return updated;
  }

  const info = fetchPrSignalInfo(updated.identity.worktree, branch);
  if (!info) {
    if (dirty) {
      writeTaskContract(taskPath, updated);
    }
    return updated;
  }

  if (info.reviewAdded && !updated.signals.reviewAdded) {
    updated = setTaskReviewAdded(updated, true);
    dirty = true;
  }
  if (info.reviewApproved && !updated.signals.reviewApproved) {
    updated = setTaskReviewApproved(updated, true);
    dirty = true;
  }
  if (info.agentReview !== updated.signals.agentReview) {
    updated = setTaskAgentReview(updated, info.agentReview);
    dirty = true;
  }
  if (info.humanReview !== updated.signals.humanReview) {
    updated = setTaskHumanReview(updated, info.humanReview);
    dirty = true;
  }
  if (info.commentsResolved !== updated.signals.commentsResolved) {
    updated = setTaskCommentsResolved(updated, info.commentsResolved);
    dirty = true;
  }
  if (info.autoMergeEnabled !== updated.signals.autoMergeEnabled) {
    updated = setTaskAutoMergeEnabled(updated, info.autoMergeEnabled);
    dirty = true;
  }

  const needsRebaseSignal = info.mergeStateStatus === "BEHIND";
  if (needsRebaseSignal !== updated.signals.needsRebase) {
    updated = setTaskNeedsRebase(updated, needsRebaseSignal);
    dirty = true;
  }

  const mergeConflictSignal = info.mergeable === "CONFLICTING";
  if (mergeConflictSignal !== updated.signals.mergeConflict) {
    updated = setTaskMergeConflict(updated, mergeConflictSignal);
    dirty = true;
  }

  if (dirty) {
    writeTaskContract(taskPath, updated);
  }

  return updated;
}

/**
 * Render the contract's derived status — the bare mode, the full derived-info
 * JSON, or the human `state (mode) - reason` line (which also refreshes task
 * signals for the default task contract when one exists). The caller decides
 * where the string goes (CLI stdout, a VerbSpec `output`, …).
 */
export function renderStatus(
  contractPath: string,
  format: "plain" | "mode" | "json",
): string {
  const info = deriveInfo(loadContract(contractPath));

  if (format === "mode") {
    return info.mode;
  }

  if (format === "json") {
    return JSON.stringify(info, null, 2);
  }

  const taskPath = defaultTaskPath();
  if (taskContractExists(taskPath)) {
    refreshTaskSignals(taskPath);
  }

  const base = `${info.state} (${info.mode})`;
  return info.reason ? `${base} - ${info.reason}` : base;
}

/**
 * `renderStatus` written to an `output` sink (returns the legacy exit code).
 * Retained for the legacy `transition` handler.
 */
export function printStatus(
  contractPath: string,
  format: "plain" | "mode" | "json",
  output: Output,
): number {
  output.log(renderStatus(contractPath, format));
  return 0;
}
