import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createActor } from "xstate";
import { describe, expect, test } from "bun:test";

import {
  completeTaskRole,
  confirmTaskScope,
  confirmTaskSuccessCriteria,
  createTaskContract,
  deriveTaskStatus,
  startTaskRole,
  setTaskRemoteCiPassed,
  setTaskReviewApproved,
  setTaskAgentReview,
  setTaskHumanReview,
  setTaskCommentsResolved,
  setTaskNeedsRebase,
  setTaskMergeConflict,
  syncTaskContract,
} from "../../src/pr-state/task.ts";
import { taskRoleMachine } from "../../src/pr-state/machine.ts";

describe("task contract and role machine", () => {
  test("creates a valid default task contract", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-task-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    const task = createTaskContract({
      workUnitId: "GH-5431",
      worktree: cwd,
      beadId: "BEAD-123",
    });

    expect(task.identity.workUnitId).toBe("GH-5431");
    expect(task.identity.beadId).toBe("BEAD-123");
    expect(task.rolePlan.currentRole).toBe("planner");
    expect(task.execution.planner.implementation).toBe("gemini");
    expect(task.execution.executor.implementation).toBe("claude");
    expect(task.execution.reviewer.implementation).toBe("copilot");
  });

  test("sync marks the spec as synced and updates provenance", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-task-sync-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    const task = createTaskContract({
      workUnitId: "GH-5431",
      worktree: cwd,
    });
    const synced = syncTaskContract(task, {
      cwd,
      beadId: "BEAD-9",
      sourceVersion: "v1",
      sourceHash: "abc123",
    });

    expect(synced.confirmations.specSynced).toBeTrue();
    expect(synced.identity.beadId).toBe("BEAD-9");
    expect(synced.provenance.beads.syncStatus).toBe("synced");
    expect(synced.provenance.local.mirrorVersion).toBe(2);
  });

  test("rejects a branch name that diverges from the issue-backed work unit id", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-task-branch-mismatch-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);

    expect(() =>
      createTaskContract({
        workUnitId: "GH-5431",
        worktree: cwd,
        branch: "pr-state-refactor",
      })
    ).toThrow(/branch must match canonical issue-backed work unit id GH-5431/);
  });

  test("rejects a worktree directory that diverges from the issue-backed work unit id", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prx-task-wrong-dir-"));

    expect(() =>
      createTaskContract({
        workUnitId: "GH-5431",
        worktree: cwd,
      })
    ).toThrow(/worktree directory must match canonical issue-backed work unit id GH-5431/);
  });

  test("role machine follows the happy path through all four roles", () => {
    const actor = createActor(taskRoleMachine);
    actor.start();
    actor.send({ type: "TASK_SPEC_SYNCED" });
    actor.send({ type: "TASK_SCOPE_CONFIRMED" });
    actor.send({ type: "TASK_SUCCESS_CRITERIA_CONFIRMED" });
    actor.send({ type: "ROLE_PLANNER_COMPLETED" });
    actor.send({ type: "ROLE_EXECUTOR_COMPLETED" });
    actor.send({ type: "REMOTE_CI_PASSED" });
    actor.send({ type: "ROLE_TESTER_COMPLETED" });
    actor.send({ type: "REVIEW_APPROVED" });
    actor.send({ type: "ROLE_REVIEWER_COMPLETED" });

    expect(actor.getSnapshot().status).toBe("done");
  });

  test("role machine blocks tester handoff when ci is pending", () => {
    const actor = createActor(taskRoleMachine);
    actor.start();
    actor.send({ type: "TASK_SPEC_SYNCED" });
    actor.send({ type: "TASK_SCOPE_CONFIRMED" });
    actor.send({ type: "TASK_SUCCESS_CRITERIA_CONFIRMED" });
    actor.send({ type: "ROLE_PLANNER_COMPLETED" });
    actor.send({ type: "ROLE_EXECUTOR_COMPLETED" });
    actor.send({ type: "ROLE_TESTER_COMPLETED" });

    expect(actor.getSnapshot().value).toBe("blocked");
  });

  test("task status reports blockers before execution can begin", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-task-status-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    let task = createTaskContract({
      workUnitId: "GH-5431",
      worktree: cwd,
    });
    task = syncTaskContract(task, {});
    task = confirmTaskScope(task);

    const status = deriveTaskStatus(task);
    expect(status.machineState).toBe("planning");
    expect(status.blockers).toContain("success criteria not confirmed");
  });

  test("task role completion auto-advances through execution and review loop", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-task-roles-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    let task = createTaskContract({
      workUnitId: "GH-5431",
      worktree: cwd,
    });
    task = syncTaskContract(task, {});
    task = confirmTaskScope(task);
    task = confirmTaskSuccessCriteria(task);
    task = completeTaskRole(task, "planner", "planned");
    expect(task.rolePlan.currentRole).toBe("executor");
    task = completeTaskRole(task, "executor", "implemented");
    expect(task.rolePlan.currentRole).toBe("tester");
    task = setTaskRemoteCiPassed(task, true);
    task = completeTaskRole(task, "tester", "green");
    expect(task.rolePlan.currentRole).toBe("reviewer");
    task = setTaskReviewApproved(task, true);
    task = completeTaskRole(task, "reviewer", "approved");
    expect(task.rolePlan.handoffStatus).toBe("completed");
  });

  test("blocked tester handoff points back at planner so PR drafting can begin", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-task-blocked-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    let task = createTaskContract({
      workUnitId: "GH-5431",
      worktree: cwd,
    });
    task = syncTaskContract(task, {});
    task = confirmTaskScope(task);
    task = confirmTaskSuccessCriteria(task);
    task = completeTaskRole(task, "planner", "planned");
    task = completeTaskRole(task, "executor", "implemented");
    task = completeTaskRole(task, "tester", "green");

    const status = deriveTaskStatus(task);
    expect(status.machineState).toBe("blocked");
    expect(status.blockers).toContain("ci pending");
    expect(status.nextRole).toBe("planner");
    expect(task.rolePlan.currentRole).toBe("planner");
  });

  test("planner restart after blocked is reflected by chronological snapshot replay", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-task-blocked-restart-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    let task = createTaskContract({
      workUnitId: "GH-5431",
      worktree: cwd,
    });
    task = syncTaskContract(task, {});
    task = confirmTaskScope(task);
    task = confirmTaskSuccessCriteria(task);
    task = completeTaskRole(task, "planner", "planned");
    task = completeTaskRole(task, "executor", "implemented");
    task = completeTaskRole(task, "tester", "green");
    task = startTaskRole(task, "planner");

    const status = deriveTaskStatus(task);
    expect(status.machineState).toBe("planning");
    expect(status.currentRole).toBe("planner");
  });

  test("review stage waits on reviewAdded before approval", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-task-review-added-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    let task = createTaskContract({
      workUnitId: "GH-5431",
      worktree: cwd,
    });
    task = syncTaskContract(task, {});
    task = confirmTaskScope(task);
    task = confirmTaskSuccessCriteria(task);
    task = completeTaskRole(task, "planner", "planned");
    task = completeTaskRole(task, "executor", "implemented");
    task = setTaskRemoteCiPassed(task, true);
    task = completeTaskRole(task, "tester", "green");

    const status = deriveTaskStatus(task);
    expect(status.machineState).toBe("reviewing");
    expect(status.blockers).toContain("review not started");
  });

  test("review comments unresolved block scout work", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-task-comments-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    let task = createTaskContract({
      workUnitId: "GH-5431",
      worktree: cwd,
    });
    task = syncTaskContract(task, {});
    task = confirmTaskScope(task);
    task = confirmTaskSuccessCriteria(task);
    task = completeTaskRole(task, "planner", "planned");
    task = completeTaskRole(task, "executor", "implemented");
    task = setTaskRemoteCiPassed(task, true);
    task = completeTaskRole(task, "tester", "green");
    task = setTaskCommentsResolved(task, false);

    const status = deriveTaskStatus(task);
    expect(status.blockers).toContain("review comments unresolved");
  });

  test("agent and human review blockers surface when comments are resolved", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-task-review-flags-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    let task = createTaskContract({
      workUnitId: "GH-5431",
      worktree: cwd,
    });
    task = syncTaskContract(task, {});
    task = confirmTaskScope(task);
    task = confirmTaskSuccessCriteria(task);
    task = completeTaskRole(task, "planner", "planned");
    task = completeTaskRole(task, "executor", "implemented");
    task = setTaskRemoteCiPassed(task, true);
    task = completeTaskRole(task, "tester", "green");
    task = setTaskCommentsResolved(task, true);
    task = setTaskAgentReview(task, true);
    task = setTaskHumanReview(task, true);

    const status = deriveTaskStatus(task);
    expect(status.blockers).toContain("agent review pending");
    expect(status.blockers).toContain("human review pending");
  });

  test("needsRebase routes back to executor when branch outdated", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-task-rebase-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    let task = createTaskContract({
      workUnitId: "GH-5431",
      worktree: cwd,
    });
    task = syncTaskContract(task, {});
    task = confirmTaskScope(task);
    task = confirmTaskSuccessCriteria(task);
    task = completeTaskRole(task, "planner", "planned");
    task = completeTaskRole(task, "executor", "implemented");
    task = setTaskRemoteCiPassed(task, true);
    task = completeTaskRole(task, "tester", "green");
    task = setTaskNeedsRebase(task, true);

    const status = deriveTaskStatus(task);
    expect(status.blockers).toContain("branch out of date (needs rebase)");
    expect(status.nextRole).toBe("executor");
  });

  test("merge conflict routes back to planner until resolved", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-task-conflict-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    let task = createTaskContract({
      workUnitId: "GH-5431",
      worktree: cwd,
    });
    task = syncTaskContract(task, {});
    task = confirmTaskScope(task);
    task = confirmTaskSuccessCriteria(task);
    task = completeTaskRole(task, "planner", "planned");
    task = setTaskMergeConflict(task, true);

    const status = deriveTaskStatus(task);
    expect(status.blockers).toContain("merge conflict detected");
    expect(status.nextRole).toBe("planner");
  });
});
