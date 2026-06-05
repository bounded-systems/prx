import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createActor } from "xstate";
import { z } from "zod";

import {
  canonicalWorkUnitIdFromBranchName,
  canonicalWorkUnitIdFromDirectory,
  canonicalWorkUnitIdPattern,
  requireCanonicalWorkUnitId,
} from "../machine/work_unit.ts";
import {
  roleExecutionStatuses,
  taskRoleMachine,
  taskRoles,
  type RoleExecutionStatus,
  type TaskRole,
  type TaskRoleEvent,
} from "../machine/machines/task.ts";
import {
  workAgentImplementations,
  type WorkAgentImplementation,
} from "../machine/runtime_profiles.ts";

const taskRoleSchema = z.enum(taskRoles);
const roleExecutionStatusSchema = z.enum(roleExecutionStatuses);
const agentImplementationSchema = z.enum(workAgentImplementations);

const roleExecutionStateSchema = z.object({
  implementation: agentImplementationSchema,
  status: roleExecutionStatusSchema,
  lastResult: z.string().nullable(),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  failedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

type RawTaskSignals = {
  ciPassed?: unknown;
  remoteCiPassed?: unknown;
  needsRebase?: unknown;
  mergeConflict?: unknown;
  reviewAdded?: unknown;
  reviewApproved?: unknown;
  agentReview?: unknown;
  humanReview?: unknown;
  commentsResolved?: unknown;
  autoMergeEnabled?: unknown;
};

function normalizeBoolean(value?: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function normalizeTaskSignals(signals: RawTaskSignals | undefined) {
  const remoteCiPassed =
    typeof signals?.remoteCiPassed === "boolean"
      ? signals.remoteCiPassed
      : typeof signals?.ciPassed === "boolean"
        ? signals.ciPassed
        : false;
  const reviewAdded = normalizeBoolean(signals?.reviewAdded);
  const reviewApproved = normalizeBoolean(signals?.reviewApproved);
  const agentReview = normalizeBoolean(signals?.agentReview);
  const humanReview = normalizeBoolean(signals?.humanReview);
  const commentsResolved = typeof signals?.commentsResolved === "boolean"
    ? signals.commentsResolved
    : true;
  const needsRebase = normalizeBoolean(signals?.needsRebase);
  const mergeConflict = normalizeBoolean(signals?.mergeConflict);
  const autoMergeEnabled = normalizeBoolean(signals?.autoMergeEnabled);
  return {
    remoteCiPassed,
    reviewAdded,
    reviewApproved,
    agentReview,
    humanReview,
    commentsResolved,
    needsRebase,
    mergeConflict,
    autoMergeEnabled,
  };
}

function normalizeTaskContractInput(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return raw;
  }

  const copied = { ...(raw as Record<string, unknown>) };
  const signals = normalizeTaskSignals((copied.signals as RawTaskSignals) ?? undefined);
  copied.signals = signals;
  return copied;
}

export const taskContractSchema = z.object({
  identity: z.object({
    workUnitId: z.string().regex(canonicalWorkUnitIdPattern),
    beadId: z.string().nullable(),
    branch: z.string(),
    worktree: z.string(),
    pr: z.number().int().nullable(),
  }).strict(),
  rolePlan: z.object({
    currentRole: taskRoleSchema,
    automaticHandoff: z.boolean(),
    claimedBy: z.string().nullable(),
    handoffStatus: z.enum(["ready", "blocked", "waiting", "completed"]),
    assignedImplementations: z.object({
      planner: agentImplementationSchema,
      executor: agentImplementationSchema,
      tester: agentImplementationSchema,
      reviewer: agentImplementationSchema,
    }).strict(),
  }).strict(),
  scope: z.object({
    files: z.array(z.string()),
    methods: z.array(z.string()),
    concerns: z.array(z.string()),
  }).strict(),
  constraints: z.object({
    forbiddenPaths: z.array(z.string()),
    invariants: z.array(z.string()),
  }).strict(),
  success: z.object({
    tests: z.array(z.string()),
    requireCiPassed: z.boolean(),
    requireReviewApproval: z.boolean(),
    requireCommentsResolved: z.boolean(),
    requireAgentReview: z.boolean(),
    requireHumanReview: z.boolean(),
    requireAutoMergeEnabled: z.boolean(),
    evidence: z.array(z.string()),
  }).strict(),
  confirmations: z.object({
    specSynced: z.boolean(),
    scopeConfirmed: z.boolean(),
    successCriteriaConfirmed: z.boolean(),
  }).strict(),
  signals: z.object({
    remoteCiPassed: z.boolean(),
    reviewAdded: z.boolean(),
    reviewApproved: z.boolean(),
    agentReview: z.boolean(),
    humanReview: z.boolean(),
    commentsResolved: z.boolean(),
    autoMergeEnabled: z.boolean(),
    needsRebase: z.boolean(),
    mergeConflict: z.boolean(),
  }).strict(),
  execution: z.object({
    planner: roleExecutionStateSchema,
    executor: roleExecutionStateSchema,
    tester: roleExecutionStateSchema,
    reviewer: roleExecutionStateSchema,
  }).strict(),
  provenance: z.object({
    beads: z.object({
      sourceVersion: z.string().nullable(),
      sourceHash: z.string().nullable(),
      lastSyncedAt: z.string().datetime({ offset: true }).nullable(),
      syncStatus: z.enum(["unknown", "synced", "drifted"]),
    }).strict(),
    local: z.object({
      mirrorVersion: z.number().int().min(1),
      updatedAt: z.string().datetime({ offset: true }),
    }).strict(),
  }).strict(),
}).strict();

export type TaskContract = z.infer<typeof taskContractSchema>;

export type TaskStatusView = {
  currentRole: TaskRole;
  machineState: string;
  handoffStatus: "ready" | "blocked" | "waiting" | "completed";
  blockers: string[];
  nextRole: TaskRole | null;
};

const roleEventByName: Record<TaskRole, {
  start: TaskRoleEvent["type"];
  complete: TaskRoleEvent["type"];
  fail: TaskRoleEvent["type"];
}> = {
  planner: {
    start: "ROLE_PLANNER_STARTED",
    complete: "ROLE_PLANNER_COMPLETED",
    fail: "ROLE_PLANNER_FAILED",
  },
  executor: {
    start: "ROLE_EXECUTOR_STARTED",
    complete: "ROLE_EXECUTOR_COMPLETED",
    fail: "ROLE_EXECUTOR_FAILED",
  },
  tester: {
    start: "ROLE_TESTER_STARTED",
    complete: "ROLE_TESTER_COMPLETED",
    fail: "ROLE_TESTER_FAILED",
  },
  reviewer: {
    start: "ROLE_REVIEWER_STARTED",
    complete: "ROLE_REVIEWER_COMPLETED",
    fail: "ROLE_REVIEWER_FAILED",
  },
};

function nowIso(): string {
  return new Date().toISOString();
}

export function defaultTaskPath(cwd = process.cwd()): string {
  return join(cwd, ".pr", "local", "task.json");
}

function defaultRoleExecutionState(
  implementation: WorkAgentImplementation,
): TaskContract["execution"][TaskRole] {
  return {
    implementation,
    status: "pending",
    lastResult: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
  };
}

export function createTaskContract(input: {
  workUnitId: string;
  worktree?: string | undefined;
  branch?: string | undefined;
  beadId?: string | null | undefined;
  pr?: number | null | undefined;
  implementations?: Partial<Record<TaskRole, WorkAgentImplementation>> | undefined;
}): TaskContract {
  const workUnitId = requireCanonicalWorkUnitId(input.workUnitId);
  const branch = input.branch ?? workUnitId;
  const branchWorkUnitId = canonicalWorkUnitIdFromBranchName(branch);
  if (branchWorkUnitId !== workUnitId) {
    throw new Error(`branch must match canonical issue-backed work unit id ${workUnitId}: ${branch}`);
  }

  const worktree = input.worktree ?? process.cwd();
  const worktreeWorkUnitId = canonicalWorkUnitIdFromDirectory(worktree);
  if (worktreeWorkUnitId !== workUnitId) {
    throw new Error(`worktree directory must match canonical issue-backed work unit id ${workUnitId}: ${worktree}`);
  }

  const timestamp = nowIso();
  const plannerImpl = input.implementations?.planner ?? "gemini";
  const executorImpl = input.implementations?.executor ?? "claude";
  const testerImpl = input.implementations?.tester ?? "codex";
  const reviewerImpl = input.implementations?.reviewer ?? "copilot";

  return {
    identity: {
      workUnitId,
      beadId: input.beadId ?? null,
      branch,
      worktree,
      pr: input.pr ?? null,
    },
    rolePlan: {
      currentRole: "planner",
      automaticHandoff: true,
      claimedBy: null,
      handoffStatus: "waiting",
      assignedImplementations: {
        planner: plannerImpl,
        executor: executorImpl,
        tester: testerImpl,
        reviewer: reviewerImpl,
      },
    },
    scope: {
      files: [],
      methods: [],
      concerns: [],
    },
    constraints: {
      forbiddenPaths: [],
      invariants: [],
    },
    success: {
      tests: [],
      requireCiPassed: true,
      requireReviewApproval: true,
      requireCommentsResolved: true,
      requireAgentReview: true,
      requireHumanReview: true,
      requireAutoMergeEnabled: false,
      evidence: [],
    },
    confirmations: {
      specSynced: false,
      scopeConfirmed: false,
      successCriteriaConfirmed: false,
    },
    signals: {
      remoteCiPassed: false,
      reviewAdded: false,
      reviewApproved: false,
      agentReview: false,
      humanReview: false,
      commentsResolved: true,
      needsRebase: false,
      mergeConflict: false,
      autoMergeEnabled: false,
    },
    execution: {
      planner: defaultRoleExecutionState(plannerImpl),
      executor: defaultRoleExecutionState(executorImpl),
      tester: defaultRoleExecutionState(testerImpl),
      reviewer: defaultRoleExecutionState(reviewerImpl),
    },
    provenance: {
      beads: {
        sourceVersion: null,
        sourceHash: null,
        lastSyncedAt: null,
        syncStatus: "unknown",
      },
      local: {
        mirrorVersion: 1,
        updatedAt: timestamp,
      },
    },
  };
}

export function loadTaskContract(path: string): TaskContract {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return taskContractSchema.parse(normalizeTaskContractInput(raw));
}

export function writeTaskContract(path: string, task: TaskContract): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(taskContractSchema.parse(task), null, 2)}\n`);
}

function buildMachineSnapshot(task: TaskContract) {
  const actor = createActor(taskRoleMachine, {
    input: undefined,
  });
  actor.start();
  if (task.confirmations.specSynced) actor.send({ type: "TASK_SPEC_SYNCED" });
  if (task.confirmations.scopeConfirmed) actor.send({ type: "TASK_SCOPE_CONFIRMED" });
  if (task.confirmations.successCriteriaConfirmed) actor.send({ type: "TASK_SUCCESS_CRITERIA_CONFIRMED" });
  if (task.signals.remoteCiPassed) actor.send({ type: "REMOTE_CI_PASSED" });
  if (task.signals.reviewApproved) actor.send({ type: "REVIEW_APPROVED" });

  const replayEvents = taskRoles.flatMap((role, roleIndex) => {
    const execution = task.execution[role];
    const roleEvents = roleEventByName[role];
    const events: Array<{ at: string; order: number; roleIndex: number; type: TaskRoleEvent["type"] }> = [];
    if (execution.startedAt) {
      events.push({ at: execution.startedAt, order: 0, roleIndex, type: roleEvents.start });
    }
    if (execution.completedAt && execution.status === "completed") {
      events.push({ at: execution.completedAt, order: 1, roleIndex, type: roleEvents.complete });
    }
    if (execution.failedAt && (execution.status === "failed" || execution.status === "blocked")) {
      events.push({ at: execution.failedAt, order: 1, roleIndex, type: roleEvents.fail });
    }
    return events;
  })
    .sort((left, right) =>
      left.at.localeCompare(right.at) ||
      left.order - right.order ||
      left.roleIndex - right.roleIndex)
    .map(({ type }) => type);

  for (const type of replayEvents) {
    actor.send({ type });
  }

  return actor.getSnapshot();
}

export function deriveTaskStatus(task: TaskContract): TaskStatusView {
  const snapshot = buildMachineSnapshot(task);
  const currentRole = task.rolePlan.currentRole;
  const blockers: string[] = [];

  if (!task.confirmations.specSynced) blockers.push("spec not synced");
  if (!task.confirmations.scopeConfirmed) blockers.push("scope not confirmed");
  if (!task.confirmations.successCriteriaConfirmed) blockers.push("success criteria not confirmed");
  if (task.success.requireCiPassed && !task.signals.remoteCiPassed && snapshot.value === "blocked") blockers.push("ci pending");
  if (task.success.requireReviewApproval && !task.signals.reviewAdded && snapshot.value === "reviewing") {
    blockers.push("review not started");
  }
  if (task.success.requireReviewApproval && task.signals.reviewAdded && !task.signals.reviewApproved && snapshot.value === "reviewing") {
    blockers.push("review approval missing");
  }
  const requireAgentReview = task.success.requireAgentReview;
  const requireHumanReview = task.success.requireHumanReview;
  const requireCommentsResolved = task.success.requireCommentsResolved;
  if (requireCommentsResolved && !task.signals.commentsResolved) {
    blockers.push("review comments unresolved");
  } else {
    if (requireAgentReview && task.signals.agentReview && !task.signals.reviewApproved) {
      blockers.push("agent review pending");
    }
    if (requireHumanReview && task.signals.humanReview && !task.signals.reviewApproved) {
      blockers.push("human review pending");
    }
  }
  if (task.success.requireAutoMergeEnabled && !task.signals.autoMergeEnabled) {
    blockers.push("auto-merge not enabled");
  }
  if (task.signals.needsRebase && !task.signals.mergeConflict) {
    blockers.push("branch out of date (needs rebase)");
  }
  if (task.signals.mergeConflict) {
    blockers.push("merge conflict detected");
  }

  let handoffStatus: TaskStatusView["handoffStatus"] = "waiting";
  if (snapshot.status === "done") {
    handoffStatus = "completed";
  } else if (blockers.length > 0 || snapshot.value === "blocked") {
    handoffStatus = "blocked";
  } else if (task.execution[currentRole].status === "completed") {
    handoffStatus = "ready";
  }

  let nextRole: TaskRole | null =
    snapshot.value === "planning" ? "planner"
      : snapshot.value === "executing" ? "executor"
      : snapshot.value === "testing" ? "tester"
      : snapshot.value === "reviewing" ? "reviewer"
      : snapshot.value === "blocked" ? "planner"
      : null;

  if (task.signals.needsRebase && !task.signals.mergeConflict) {
    nextRole = "executor";
  }

  if (task.signals.mergeConflict) {
    nextRole = "planner";
  }

  return {
    currentRole,
    machineState: String(snapshot.value),
    handoffStatus,
    blockers,
    nextRole,
  };
}

export function syncTaskContract(task: TaskContract, input: {
  cwd?: string | undefined;
  beadId?: string | null | undefined;
  sourceVersion?: string | null | undefined;
  sourceHash?: string | null | undefined;
}): TaskContract {
  const workUnitId = requireCanonicalWorkUnitId(task.identity.workUnitId);
  const worktree = input.cwd ?? task.identity.worktree;
  const worktreeWorkUnitId = canonicalWorkUnitIdFromDirectory(worktree);
  if (worktreeWorkUnitId !== workUnitId) {
    throw new Error(`worktree directory must match canonical issue-backed work unit id ${workUnitId}: ${worktree}`);
  }
  const timestamp = nowIso();
  return taskContractSchema.parse({
    ...task,
    identity: {
      ...task.identity,
      branch: workUnitId,
      worktree,
      beadId: input.beadId ?? task.identity.beadId,
    },
    confirmations: {
      ...task.confirmations,
      specSynced: true,
    },
    provenance: {
      beads: {
        sourceVersion: input.sourceVersion ?? task.provenance.beads.sourceVersion,
        sourceHash: input.sourceHash ?? task.provenance.beads.sourceHash,
        lastSyncedAt: timestamp,
        syncStatus: "synced",
      },
      local: {
        mirrorVersion: task.provenance.local.mirrorVersion + 1,
        updatedAt: timestamp,
      },
    },
  });
}

function withUpdatedExecution(
  task: TaskContract,
  role: TaskRole,
  patch: Partial<TaskContract["execution"][TaskRole]>,
): TaskContract {
  return taskContractSchema.parse({
    ...task,
    rolePlan: {
      ...task.rolePlan,
      currentRole: role,
    },
    execution: {
      ...task.execution,
      [role]: {
        ...task.execution[role],
        ...patch,
      },
    },
    provenance: {
      ...task.provenance,
      local: {
        mirrorVersion: task.provenance.local.mirrorVersion + 1,
        updatedAt: nowIso(),
      },
    },
  });
}

export function startTaskRole(
  task: TaskContract,
  role: TaskRole,
  implementation?: WorkAgentImplementation,
): TaskContract {
  const resolvedImplementation = implementation ?? task.rolePlan.assignedImplementations[role];
  return withUpdatedExecution(task, role, {
    implementation: resolvedImplementation,
    status: "running",
    startedAt: nowIso(),
    failedAt: null,
    completedAt: null,
    lastResult: null,
  });
}

export function completeTaskRole(task: TaskContract, role: TaskRole, result?: string | null): TaskContract {
  const nextTask = withUpdatedExecution(task, role, {
    status: "completed",
    completedAt: nowIso(),
    lastResult: result ?? null,
    failedAt: null,
  });

  const status = deriveTaskStatus(nextTask);
  const nextRole = status.nextRole ?? role;

  return taskContractSchema.parse({
    ...nextTask,
    rolePlan: {
      ...nextTask.rolePlan,
      currentRole: nextRole,
      handoffStatus: status.handoffStatus,
    },
  });
}

export function failTaskRole(task: TaskContract, role: TaskRole, reason?: string | null): TaskContract {
  const nextTask = withUpdatedExecution(task, role, {
    status: "failed",
    failedAt: nowIso(),
    lastResult: reason ?? null,
  });
  const status = deriveTaskStatus(nextTask);

  return taskContractSchema.parse({
    ...nextTask,
    rolePlan: {
      ...nextTask.rolePlan,
      currentRole: status.nextRole ?? "planner",
      handoffStatus: status.handoffStatus,
    },
  });
}

export function confirmTaskScope(task: TaskContract): TaskContract {
  return taskContractSchema.parse({
    ...task,
    confirmations: {
      ...task.confirmations,
      scopeConfirmed: true,
    },
    provenance: {
      ...task.provenance,
      local: {
        mirrorVersion: task.provenance.local.mirrorVersion + 1,
        updatedAt: nowIso(),
      },
    },
  });
}

export function confirmTaskSuccessCriteria(task: TaskContract): TaskContract {
  return taskContractSchema.parse({
    ...task,
    confirmations: {
      ...task.confirmations,
      successCriteriaConfirmed: true,
    },
    provenance: {
      ...task.provenance,
      local: {
        mirrorVersion: task.provenance.local.mirrorVersion + 1,
        updatedAt: nowIso(),
      },
    },
  });
}

export function setTaskRemoteCiPassed(task: TaskContract, remoteCiPassed: boolean): TaskContract {
  return taskContractSchema.parse({
    ...task,
    signals: {
      ...task.signals,
      remoteCiPassed,
    },
    provenance: {
      ...task.provenance,
      local: {
        mirrorVersion: task.provenance.local.mirrorVersion + 1,
        updatedAt: nowIso(),
      },
    },
  });
}

export function setTaskReviewAdded(task: TaskContract, reviewAdded: boolean): TaskContract {
  return taskContractSchema.parse({
    ...task,
    signals: {
      ...task.signals,
      reviewAdded,
    },
    provenance: {
      ...task.provenance,
      local: {
        mirrorVersion: task.provenance.local.mirrorVersion + 1,
        updatedAt: nowIso(),
      },
    },
  });
}

export function setTaskReviewApproved(task: TaskContract, reviewApproved: boolean): TaskContract {
  return taskContractSchema.parse({
    ...task,
    signals: {
      ...task.signals,
      reviewApproved,
    },
    provenance: {
      ...task.provenance,
      local: {
        mirrorVersion: task.provenance.local.mirrorVersion + 1,
        updatedAt: nowIso(),
      },
    },
  });
}

export function setTaskAgentReview(task: TaskContract, agentReview: boolean): TaskContract {
  return taskContractSchema.parse({
    ...task,
    signals: {
      ...task.signals,
      agentReview,
    },
    provenance: {
      ...task.provenance,
      local: {
        mirrorVersion: task.provenance.local.mirrorVersion + 1,
        updatedAt: nowIso(),
      },
    },
  });
}

export function setTaskHumanReview(task: TaskContract, humanReview: boolean): TaskContract {
  return taskContractSchema.parse({
    ...task,
    signals: {
      ...task.signals,
      humanReview,
    },
    provenance: {
      ...task.provenance,
      local: {
        mirrorVersion: task.provenance.local.mirrorVersion + 1,
        updatedAt: nowIso(),
      },
    },
  });
}

export function setTaskCommentsResolved(task: TaskContract, commentsResolved: boolean): TaskContract {
  return taskContractSchema.parse({
    ...task,
    signals: {
      ...task.signals,
      commentsResolved,
    },
    provenance: {
      ...task.provenance,
      local: {
        mirrorVersion: task.provenance.local.mirrorVersion + 1,
        updatedAt: nowIso(),
      },
    },
  });
}

export function setTaskAutoMergeEnabled(task: TaskContract, autoMergeEnabled: boolean): TaskContract {
  return taskContractSchema.parse({
    ...task,
    signals: {
      ...task.signals,
      autoMergeEnabled,
    },
    provenance: {
      ...task.provenance,
      local: {
        mirrorVersion: task.provenance.local.mirrorVersion + 1,
        updatedAt: nowIso(),
      },
    },
  });
}

export function setTaskNeedsRebase(task: TaskContract, needsRebase: boolean): TaskContract {
  return taskContractSchema.parse({
    ...task,
    signals: {
      ...task.signals,
      needsRebase,
    },
    provenance: {
      ...task.provenance,
      local: {
        mirrorVersion: task.provenance.local.mirrorVersion + 1,
        updatedAt: nowIso(),
      },
    },
  });
}

export function setTaskMergeConflict(task: TaskContract, mergeConflict: boolean): TaskContract {
  return taskContractSchema.parse({
    ...task,
    signals: {
      ...task.signals,
      mergeConflict,
    },
    provenance: {
      ...task.provenance,
      local: {
        mirrorVersion: task.provenance.local.mirrorVersion + 1,
        updatedAt: nowIso(),
      },
    },
  });
}

export function setTaskSuccessRequirements(
  task: TaskContract,
  patch: Partial<Pick<TaskContract["success"],
    "requireCommentsResolved" | "requireAgentReview" | "requireHumanReview" | "requireAutoMergeEnabled">>,
): TaskContract {
  if (Object.keys(patch).length === 0) {
    return task;
  }
  return taskContractSchema.parse({
    ...task,
    success: {
      ...task.success,
      ...patch,
    },
    provenance: {
      ...task.provenance,
      local: {
        mirrorVersion: task.provenance.local.mirrorVersion + 1,
        updatedAt: nowIso(),
      },
    },
  });
}

export function taskContractExists(path: string): boolean {
  return existsSync(path);
}
