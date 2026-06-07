import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  boardStatus,
  fetchPrComments,
  repoStatus,
  type BoardColumn,
  type BoardStatusResult,
  type CommandRunner,
  type RepoStatusResult,
} from "./github.ts";
import { deriveInfo, loadContract, type StateMode } from "./contract.ts";
import { isSystemMergeReady, lifecycleStates, type LifecycleState, type PrSystemContext } from "./machine.ts";
import {
  defaultTaskPath,
  deriveTaskStatus,
  loadTaskContract,
  taskContractExists,
  taskContractSchema,
  type TaskContract,
} from "./task.ts";
import {
  assertInvariants,
  derivePhase,
  rawStateV1Schema,
  workflowPhases,
  type InvariantFinding,
  type InvariantReport,
  type RawStateV1,
  type WorkflowPhase,
} from "./raw_state.ts";
import { taskRoles, type TaskRole } from "../machine/machines/task.ts";

const localCountsSchema = z.object({
  staged: z.number().int().min(0),
  unstaged: z.number().int().min(0),
  untracked: z.number().int().min(0),
  ignored: z.number().int().min(0),
  conflicts: z.number().int().min(0),
}).strict();

const boardColumns = [
  "no_worktree",
  "worktree_created",
  "branch_created",
  "committing",
  "pushed",
  "pr_open",
  "ci_running",
  "review",
  "changes_requested",
  "approved",
  "merge_ready",
  "cleanup_pending",
  "merged",
  "cleaned",
] as const satisfies readonly BoardColumn[];

const prStatusSchema = z.object({
  exists: z.boolean(),
  number: z.number().int().nullable(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  draft: z.boolean().nullable(),
  checks: z.enum(["green", "red", "pending", "unknown"]).nullable(),
  review: z.enum(["approved", "changes_requested", "review_required", "commented", "unknown"]).nullable(),
  approvals: z.number().int().nullable(),
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]).nullable(),
}).strict();

const currentUnitSchema = z.object({
  ticket: z.string().nullable(),
  beadId: z.string().nullable(),
  branch: z.string(),
  worktreePath: z.string().nullable(),
  column: z.enum(boardColumns),
  reasons: z.array(z.string()),
}).strict();

const prSystemContextSchema = z.object({
  lifecycle: z.enum(["drafting", "open", "merged", "closed"]),
  review: z.enum(["none", "in_review", "approved", "changes_requested"]),
  ci: z.enum(["pending", "running", "passed", "failed"]),
  mergeability: z.enum(["unknown", "clean", "blocked", "dirty"]),
}).strict();

const prContractStateSchema = z.object({
  exists: z.boolean(),
  mode: z.enum(["draft", "ready"]).nullable(),
  state: z.enum(lifecycleStates).nullable(),
  title: z.string().nullable(),
  reason: z.string().nullable(),
}).strict();

const taskRoleSchema = z.enum(taskRoles);

const workflowTaskStateSchema = z.object({
  exists: z.boolean(),
  currentRole: taskRoleSchema.nullable(),
  machineState: z.string().nullable(),
  handoffStatus: z.enum(["ready", "blocked", "waiting", "completed"]).nullable(),
  blockers: z.array(z.string()),
  nextRole: taskRoleSchema.nullable(),
}).strict();

const reviewStateSchema = z.object({
  decision: z.enum(["none", "changes_requested", "approved"]),
  reviewersRequested: z.boolean(),
  unresolvedThreads: z.number().int().min(0),
  approvals: z.number().int().nullable(),
  agentReview: z.boolean().nullable(),
  humanReview: z.boolean().nullable(),
  commentsResolved: z.boolean().nullable(),
}).strict();

const invariantFindingSchema = z.object({
  id: z.string(),
  severity: z.literal("hard"),
  message: z.string(),
}).strict();

const invariantReportSchema = z.object({
  valid: z.boolean(),
  findings: z.array(invariantFindingSchema),
}).strict();

// GH-352: the local CI provenance projection — the merge-guard verdict plus a
// freshness signal (does the recorded green still cover the current tree?).
export const ciProvenanceStateSchema = z.object({
  verdict: z.enum(["verified", "unsigned", "unchecked"]),
  freshness: z.enum(["fresh", "stale", "unknown"]),
}).strict();

const DEFAULT_CI_PROVENANCE = { verdict: "unchecked", freshness: "unknown" } as const;

export const domainStateV1Schema = z.object({
  kind: z.literal("DomainStateV1"),
  taskContract: taskContractSchema.nullable(),
  ci: ciProvenanceStateSchema,
  prState: z.object({
    pr: prStatusSchema,
    system: prSystemContextSchema,
    contract: prContractStateSchema,
    mergeReady: z.boolean(),
  }).strict(),
  workflowState: z.object({
    phase: z.enum(workflowPhases),
    task: workflowTaskStateSchema,
  }).strict(),
  repoState: z.object({
    repoRoot: z.string(),
    branch: z.string().nullable(),
    operation: z.enum(["none", "merge", "rebase", "cherry-pick"]),
    remoteFreshness: z.enum(["fresh", "stale", "unknown"]),
    local: localCountsSchema,
    currentUnit: currentUnitSchema.nullable(),
    artifacts: rawStateV1Schema.shape.artifacts,
    sync: rawStateV1Schema.shape.sync,
  }).strict(),
  reviewState: reviewStateSchema,
  rawState: rawStateV1Schema,
  invariants: invariantReportSchema,
}).strict();

export type DomainStateV1 = z.infer<typeof domainStateV1Schema>;

function defaultContractPath(cwd = process.cwd()): string {
  return join(cwd, ".pr", "local", "pr.json");
}

export function defaultDomainStatePath(cwd = process.cwd()): string {
  return join(cwd, ".pr", "local", "domain-state.json");
}

function mapReviewState(
  review: RepoStatusResult["pr"]["review"],
): PrSystemContext["review"] {
  if (review === "approved") return "approved";
  if (review === "changes_requested") return "changes_requested";
  if (review === "review_required" || review === "commented") return "in_review";
  return "none";
}

function mapCiState(checks: RepoStatusResult["pr"]["checks"]): PrSystemContext["ci"] {
  if (checks === "green") return "passed";
  if (checks === "red") return "failed";
  if (checks === "pending") return "running";
  return "pending";
}

function mapCiRaw(checks: RepoStatusResult["pr"]["checks"]): RawStateV1["signals"]["ci"]["state"] {
  if (checks === "green") return "passed";
  if (checks === "red") return "failed";
  if (checks === "pending") return "in_progress";
  return "none";
}

function mapMergeabilityState(
  mergeable: RepoStatusResult["pr"]["mergeable"],
): PrSystemContext["mergeability"] {
  if (mergeable === "mergeable") return "clean";
  if (mergeable === "conflicting") return "dirty";
  return "unknown";
}

function mapMergeabilityRaw(mergeable: RepoStatusResult["pr"]["mergeable"]): RawStateV1["signals"]["mergeability"]["state"] {
  if (mergeable === "mergeable") return "mergeable";
  if (mergeable === "conflicting") return "conflicting";
  return "unknown";
}

function deriveSystemState(repo: RepoStatusResult): PrSystemContext {
  const lifecycle: PrSystemContext["lifecycle"] =
    repo.pr.exists
      ? (repo.pr.draft ? "drafting" : "open")
      : "drafting";

  return {
    lifecycle,
    review: mapReviewState(repo.pr.review),
    ci: mapCiState(repo.pr.checks),
    mergeability: mapMergeabilityState(repo.pr.mergeable),
  };
}

function deriveRawState(
  repo: RepoStatusResult,
  currentUnit: BoardStatusResult["units"][number] | null,
  unresolvedThreads = 0,
): RawStateV1 {
  const ciStatus = mapCiRaw(repo.pr.checks);
  const reviewDecision: RawStateV1["signals"]["review"]["decision"] =
    repo.pr.review === "approved"
      ? "approved"
      : repo.pr.review === "changes_requested"
        ? "changes_requested"
        : "none";
  const prState: RawStateV1["artifacts"]["pr"]["state"] = repo.pr.exists ? "open" : "none";
  const detachedSurveyContext = repo.local.branch.detached && currentUnit?.branch === "MAIN";
  const branchName = repo.local.branch.name ?? (detachedSurveyContext ? currentUnit.branch : null);
  const worktreeExists = currentUnit?.worktree_path != null || Boolean(branchName);
  const branchExistsLocal = detachedSurveyContext ? true : Boolean(branchName);
  const upstreamExists = detachedSurveyContext ? true : repo.local.branch.upstream !== null;
  const now = new Date().toISOString();
  const headLocal = null;
  const headRemote = null;
  const remoteFresh =
    repo.remote.freshness === "fresh" &&
    repo.local.branch.ahead === 0 &&
    repo.local.branch.behind === 0;

  return rawStateV1Schema.parse({
    unitId: currentUnit?.ticket ?? branchName ?? repo.repo_root,
    artifacts: {
      ticket: {
        exists: (currentUnit?.ticket ?? null) !== null,
        id: currentUnit?.ticket ?? null,
        system: "other",
        url: null,
      },
      worktree: {
        exists: worktreeExists,
        path: currentUnit?.worktree_path ?? (worktreeExists ? repo.repo_root : null),
        checkedOutBranch: branchName,
        headSha: headLocal,
      },
      branch: {
        name: branchName,
        existsLocal: branchExistsLocal,
        existsRemote: upstreamExists || repo.pr.exists,
        ahead: repo.local.branch.ahead,
        behind: repo.local.branch.behind,
        headShaLocal: headLocal,
        headShaRemote: headRemote,
      },
      pr: {
        exists: repo.pr.exists,
        number: repo.pr.number,
        state: prState,
        isDraft: repo.pr.exists ? repo.pr.draft : null,
        headRef: repo.pr.exists ? branchName : null,
        baseRef: null,
        url: repo.pr.url,
        autoMergeRequest: null,
      },
    },
    signals: {
      review: {
        decision: reviewDecision,
        reviewersRequested: repo.pr.review !== null && repo.pr.review !== "unknown",
        unresolvedThreads,
      },
      ci: {
        state: ciStatus,
        requiredTotal: ciStatus === "none" ? 0 : 1,
        requiredPassed: ciStatus === "passed" ? 1 : 0,
        failing: ciStatus === "failed" ? ["required_checks"] : [],
      },
      mergeability: {
        state: repo.pr.exists && repo.pr.draft ? "draft" : mapMergeabilityRaw(repo.pr.mergeable),
        blockedReasons: unresolvedThreads > 0 ? ["unresolved_review_threads"] : [],
      },
    },
    sync: {
      remoteFresh,
      ticketLinkedToPR: repo.pr.exists ? (currentUnit?.ticket ?? null) !== null : null,
    },
    meta: {
      observedAt: now,
      sources: {
        git: now,
        gh: now,
        ticketSystem: (currentUnit?.ticket ?? null) !== null ? now : null,
      },
    },
  });
}

function summarizeCurrentUnit(
  currentUnit: BoardStatusResult["units"][number] | null,
): DomainStateV1["repoState"]["currentUnit"] {
  if (!currentUnit) {
    return null;
  }
  return {
    ticket: currentUnit.ticket ?? null,
    beadId: currentUnit.beadId ?? null,
    branch: currentUnit.branch,
    worktreePath: currentUnit.worktree_path ?? null,
    column: currentUnit.column,
    reasons: [...currentUnit.reasons],
  };
}

function deriveContractState(
  contractPath: string,
): DomainStateV1["prState"]["contract"] {
  if (!existsSync(contractPath)) {
    return {
      exists: false,
      mode: null,
      state: null,
      title: null,
      reason: null,
    };
  }

  const info = deriveInfo(loadContract(contractPath));
  return {
    exists: true,
    mode: info.mode,
    state: info.state,
    title: info.title ?? null,
    reason: info.reason ?? null,
  };
}

function deriveWorkflowTaskState(
  task: TaskContract | null,
): DomainStateV1["workflowState"]["task"] {
  if (!task) {
    return {
      exists: false,
      currentRole: null,
      machineState: null,
      handoffStatus: null,
      blockers: [],
      nextRole: null,
    };
  }

  const status = deriveTaskStatus(task);
  return {
    exists: true,
    currentRole: status.currentRole,
    machineState: status.machineState,
    handoffStatus: status.handoffStatus,
    blockers: [...status.blockers],
    nextRole: status.nextRole,
  };
}

export function buildDomainState(
  repoPath: string,
  runner?: CommandRunner,
  // GH-352: the CI provenance projection. Kept a parameter (not read inline) so
  // `buildDomainState` stays synchronous and ledger-free; the async chain read
  // happens at the write boundary (`prx snapshot`) and is passed in. Defaults to
  // unchecked/unknown when no ledger is resolvable.
  ci: z.infer<typeof ciProvenanceStateSchema> = DEFAULT_CI_PROVENANCE,
): DomainStateV1 {
  const repo = repoStatus(repoPath, { includeGitDetails: true, fetch: false }, runner);
  const board = boardStatus(repoPath, runner);
  const branch = repo.local.branch.name;
  const currentUnit =
    board.units.find((unit) => unit.worktree_path === repo.repo_root)
    ?? (branch ? board.units.find((unit) => unit.branch === branch) ?? null : null);
  const unresolvedThreads =
    repo.pr.exists && repo.pr.number !== null
      ? fetchPrComments(repoPath, String(repo.pr.number), runner).unresolvedThreads
      : 0;
  const rawState = deriveRawState(repo, currentUnit, unresolvedThreads);
  const phase = derivePhase(rawState);
  const system = deriveSystemState(repo);
  const mergeReady = phase === "ready_to_merge" && isSystemMergeReady(system);
  const invariants = assertInvariants(rawState, phase);
  const taskPath = defaultTaskPath(repo.repo_root);
  const task = taskContractExists(taskPath) ? loadTaskContract(taskPath) : null;
  const contractPath = defaultContractPath(repo.repo_root);

  return domainStateV1Schema.parse({
    kind: "DomainStateV1",
    taskContract: task,
    ci,
    prState: {
      pr: repo.pr,
      system,
      contract: deriveContractState(contractPath),
      mergeReady,
    },
    workflowState: {
      phase,
      task: deriveWorkflowTaskState(task),
    },
    repoState: {
      repoRoot: repo.repo_root,
      branch,
      operation: repo.operation,
      remoteFreshness: repo.remote.freshness,
      local: repo.local.counts,
      currentUnit: summarizeCurrentUnit(currentUnit),
      artifacts: rawState.artifacts,
      sync: rawState.sync,
    },
    reviewState: {
      decision: rawState.signals.review.decision,
      reviewersRequested: rawState.signals.review.reviewersRequested,
      unresolvedThreads,
      approvals: repo.pr.approvals,
      agentReview: task?.signals.agentReview ?? null,
      humanReview: task?.signals.humanReview ?? null,
      commentsResolved: task?.signals.commentsResolved ?? null,
    },
    rawState,
    invariants,
  });
}

export function refreshDomainStateFromGitHub(
  repoPath: string,
  runner?: CommandRunner,
): DomainStateV1 {
  return buildDomainState(repoPath, runner);
}

export function loadDomainState(path: string): DomainStateV1 {
  return domainStateV1Schema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function writeDomainState(path: string, state: DomainStateV1): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(domainStateV1Schema.parse(state), null, 2)}\n`);
}
