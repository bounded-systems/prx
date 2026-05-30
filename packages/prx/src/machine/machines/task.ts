import { assign, setup } from "xstate";

export const taskRoles = ["planner", "executor", "tester", "reviewer"] as const;
export type TaskRole = (typeof taskRoles)[number];

export const roleExecutionStatuses = [
  "pending",
  "running",
  "completed",
  "failed",
  "blocked",
] as const;
export type RoleExecutionStatus = (typeof roleExecutionStatuses)[number];

export type TaskRoleEvent =
  | { type: "TASK_SPEC_SYNCED" }
  | { type: "TASK_SCOPE_CONFIRMED" }
  | { type: "TASK_SUCCESS_CRITERIA_CONFIRMED" }
  | { type: "REMOTE_CI_QUEUED" }
  | { type: "REMOTE_CI_STARTED" }
  | { type: "REMOTE_CI_PASSED" }
  | { type: "REMOTE_CI_FAILED" }
  | { type: "REVIEW_APPROVED" }
  | { type: "CHANGES_REQUESTED" }
  | { type: "ROLE_PLANNER_STARTED" }
  | { type: "ROLE_PLANNER_COMPLETED" }
  | { type: "ROLE_PLANNER_FAILED" }
  | { type: "ROLE_EXECUTOR_STARTED" }
  | { type: "ROLE_EXECUTOR_COMPLETED" }
  | { type: "ROLE_EXECUTOR_FAILED" }
  | { type: "ROLE_TESTER_STARTED" }
  | { type: "ROLE_TESTER_COMPLETED" }
  | { type: "ROLE_TESTER_FAILED" }
  | { type: "ROLE_REVIEWER_STARTED" }
  | { type: "ROLE_REVIEWER_COMPLETED" }
  | { type: "ROLE_REVIEWER_FAILED" };

export type TaskRoleContext = {
  specSynced: boolean;
  scopeConfirmed: boolean;
  successCriteriaConfirmed: boolean;
  ciPassed: boolean;
  reviewApproved: boolean;
  roleStatus: Record<TaskRole, RoleExecutionStatus>;
};

export const initialTaskRoleContext: TaskRoleContext = {
  specSynced: false,
  scopeConfirmed: false,
  successCriteriaConfirmed: false,
  ciPassed: false,
  reviewApproved: false,
  roleStatus: {
    planner: "pending",
    executor: "pending",
    tester: "pending",
    reviewer: "pending",
  },
};

function updateRoleStatus(role: TaskRole, status: RoleExecutionStatus) {
  return ({ context }: { context: TaskRoleContext }) => ({
    ...context.roleStatus,
    [role]: status,
  });
}

export const taskRoleMachine = setup({
  types: {
    context: {} as TaskRoleContext,
    events: {} as TaskRoleEvent,
  },
  guards: {
    planningComplete: ({ context }) =>
      context.specSynced && context.scopeConfirmed && context.successCriteriaConfirmed,
    ciPassed: ({ context }) => context.ciPassed,
    reviewApproved: ({ context }) => context.reviewApproved,
  },
  actions: {
    markSpecSynced: assign({
      specSynced: () => true,
    }),
    markScopeConfirmed: assign({
      scopeConfirmed: () => true,
    }),
    markSuccessCriteriaConfirmed: assign({
      successCriteriaConfirmed: () => true,
    }),
    markCiPassed: assign({
      ciPassed: () => true,
    }),
    markCiFailed: assign({
      ciPassed: () => false,
    }),
    markReviewApproved: assign({
      reviewApproved: () => true,
    }),
    markReviewRejected: assign({
      reviewApproved: () => false,
    }),
    setPlannerRunning: assign({
      roleStatus: updateRoleStatus("planner", "running"),
    }),
    setPlannerCompleted: assign({
      roleStatus: updateRoleStatus("planner", "completed"),
    }),
    setPlannerFailed: assign({
      roleStatus: updateRoleStatus("planner", "failed"),
    }),
    setExecutorRunning: assign({
      roleStatus: updateRoleStatus("executor", "running"),
    }),
    setExecutorCompleted: assign({
      roleStatus: updateRoleStatus("executor", "completed"),
    }),
    setExecutorFailed: assign({
      roleStatus: updateRoleStatus("executor", "failed"),
    }),
    setTesterRunning: assign({
      roleStatus: updateRoleStatus("tester", "running"),
    }),
    setTesterCompleted: assign({
      roleStatus: updateRoleStatus("tester", "completed"),
    }),
    setTesterBlocked: assign({
      roleStatus: updateRoleStatus("tester", "blocked"),
    }),
    setTesterFailed: assign({
      roleStatus: updateRoleStatus("tester", "failed"),
    }),
    setReviewerRunning: assign({
      roleStatus: updateRoleStatus("reviewer", "running"),
    }),
    setReviewerCompleted: assign({
      roleStatus: updateRoleStatus("reviewer", "completed"),
    }),
    setReviewerFailed: assign({
      roleStatus: updateRoleStatus("reviewer", "failed"),
    }),
  },
}).createMachine({
  id: "taskRoleSystem",
  initial: "planning",
  context: initialTaskRoleContext,
  on: {
    TASK_SPEC_SYNCED: {
      actions: { type: "markSpecSynced" },
    },
    TASK_SCOPE_CONFIRMED: {
      actions: { type: "markScopeConfirmed" },
    },
    TASK_SUCCESS_CRITERIA_CONFIRMED: {
      actions: { type: "markSuccessCriteriaConfirmed" },
    },
    REMOTE_CI_QUEUED: {
      actions: { type: "markCiFailed" },
    },
    REMOTE_CI_STARTED: {
      actions: { type: "markCiFailed" },
    },
    REMOTE_CI_PASSED: {
      actions: { type: "markCiPassed" },
    },
    REMOTE_CI_FAILED: {
      actions: { type: "markCiFailed" },
    },
    REVIEW_APPROVED: {
      actions: { type: "markReviewApproved" },
    },
    CHANGES_REQUESTED: {
      actions: { type: "markReviewRejected" },
    },
  },
  states: {
    planning: {
      on: {
        ROLE_PLANNER_STARTED: {
          actions: { type: "setPlannerRunning" },
        },
        ROLE_PLANNER_COMPLETED: {
          target: "executing",
          actions: { type: "setPlannerCompleted" },
          guard: { type: "planningComplete" },
        },
        ROLE_PLANNER_FAILED: {
          actions: { type: "setPlannerFailed" },
        },
      },
    },
    executing: {
      on: {
        ROLE_EXECUTOR_STARTED: {
          actions: { type: "setExecutorRunning" },
        },
        ROLE_EXECUTOR_COMPLETED: {
          target: "testing",
          actions: { type: "setExecutorCompleted" },
        },
        ROLE_EXECUTOR_FAILED: {
          target: "planning",
          actions: { type: "setExecutorFailed" },
        },
      },
    },
    testing: {
      on: {
        ROLE_TESTER_STARTED: {
          actions: { type: "setTesterRunning" },
        },
        ROLE_TESTER_COMPLETED: [
          {
            target: "reviewing",
            guard: { type: "ciPassed" },
            actions: { type: "setTesterCompleted" },
          },
          {
            target: "blocked",
            actions: { type: "setTesterBlocked" },
          },
        ],
        ROLE_TESTER_FAILED: {
          target: "executing",
          actions: { type: "setTesterFailed" },
        },
      },
    },
    reviewing: {
      on: {
        ROLE_REVIEWER_STARTED: {
          actions: { type: "setReviewerRunning" },
        },
        ROLE_REVIEWER_COMPLETED: [
          {
            target: "done",
            guard: { type: "reviewApproved" },
            actions: { type: "setReviewerCompleted" },
          },
          {
            target: "executing",
            actions: { type: "setReviewerFailed" },
          },
        ],
        ROLE_REVIEWER_FAILED: {
          target: "executing",
          actions: { type: "setReviewerFailed" },
        },
      },
    },
    blocked: {
      on: {
        REMOTE_CI_PASSED: {
          target: "reviewing",
          actions: { type: "markCiPassed" },
        },
        ROLE_TESTER_FAILED: {
          target: "executing",
          actions: { type: "setTesterFailed" },
        },
        ROLE_PLANNER_STARTED: {
          target: "planning",
          actions: { type: "setPlannerRunning" },
        },
      },
    },
    done: {
      type: "final",
    },
  },
});
