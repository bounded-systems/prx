import type { BoardStatusResult, CommandRunner, RepoStatusResult } from "./github.ts";
import type { PrSystemContext } from "./machine.ts";
import type { ToolActor } from "./actors.ts";
import type { InvariantReport, RawStateV1, WorkflowPhase } from "./raw_state.ts";
import { buildDomainState } from "./domain_state.ts";

export type ActionSurface = "skill" | "tool";

export type ActionSnapshot = {
  repoRoot: string;
  branch: string | null;
  contractExists: boolean;
  operation: RepoStatusResult["operation"];
  remoteFreshness: RepoStatusResult["remote"]["freshness"];
  local: RepoStatusResult["local"]["counts"];
  pr: RepoStatusResult["pr"];
  system: PrSystemContext;
  mergeReady: boolean;
  phase: WorkflowPhase;
  currentUnit: BoardStatusResult["units"][number] | null;
  rawState: RawStateV1;
  invariants: InvariantReport;
};

export type ResolvedAction = {
  id: string;
  actor: ToolActor;
  surface: ActionSurface;
  label: string;
  reason?: string | undefined;
  command: string;
  priority: number;
  enabled: boolean;
  disabledReason?: string | undefined;
};

export type ActionPlan = {
  snapshot: ActionSnapshot;
  actions: ResolvedAction[];
  next: ResolvedAction | null;
};

type ActionDefinition = {
  id: string;
  actor: ToolActor;
  surface: ActionSurface;
  label: string;
  priority: number;
  command: (snapshot: ActionSnapshot) => string;
  reason: (snapshot: ActionSnapshot) => string;
  when: (snapshot: ActionSnapshot) => boolean;
  disabledReason: (snapshot: ActionSnapshot) => string | null;
};

function formatPrCommand(
  command: string,
  prNumber: number | null,
  ...args: string[]
): string {
  const target = prNumber === null ? "<pr-number>" : String(prNumber);
  return [command, target, ...args].join(" ");
}

function hasBranchContext(snapshot: Pick<ActionSnapshot, "branch">): boolean {
  return snapshot.branch !== null;
}

export function buildActionSnapshot(
  repoPath: string,
  runner?: CommandRunner,
): ActionSnapshot {
  const domainState = buildDomainState(repoPath, runner);

  return {
    repoRoot: domainState.repoState.repoRoot,
    branch: domainState.repoState.branch,
    contractExists: domainState.prState.contract.exists,
    operation: domainState.repoState.operation,
    remoteFreshness: domainState.repoState.remoteFreshness,
    local: domainState.repoState.local,
    pr: domainState.prState.pr,
    system: domainState.prState.system,
    mergeReady: domainState.prState.mergeReady,
    phase: domainState.workflowState.phase,
    currentUnit: domainState.repoState.currentUnit
      ? {
        ticket: domainState.repoState.currentUnit.ticket,
        beadId: domainState.repoState.currentUnit.beadId,
        branch: domainState.repoState.currentUnit.branch,
        worktree_path: domainState.repoState.currentUnit.worktreePath,
        pr: domainState.prState.pr,
        artifacts: {
          worktree: domainState.rawState.artifacts.worktree.exists,
          branch: domainState.rawState.artifacts.branch.existsLocal,
          pr: domainState.rawState.artifacts.pr.exists,
          ticket: domainState.rawState.artifacts.ticket.exists,
        },
        local: {
          clean:
            domainState.repoState.local.staged === 0 &&
            domainState.repoState.local.unstaged === 0 &&
            domainState.repoState.local.untracked === 0 &&
            domainState.repoState.local.conflicts === 0,
          staged: domainState.repoState.local.staged,
          unstaged: domainState.repoState.local.unstaged,
          untracked: domainState.repoState.local.untracked,
          conflicts: domainState.repoState.local.conflicts,
        },
        column: domainState.repoState.currentUnit.column,
        reasons: [...domainState.repoState.currentUnit.reasons],
      }
      : null,
    rawState: domainState.rawState,
    invariants: domainState.invariants,
  };
}

const actionCatalog: ActionDefinition[] = [
  {
    id: "contract.init",
    actor: "git",
    surface: "skill",
    label: "Initialize PR contract",
    priority: 10,
    command: () => "prx contract init",
    reason: () => "Missing .pr/local/pr.json",
    when: (snapshot) => hasBranchContext(snapshot) && !snapshot.contractExists,
    disabledReason: (snapshot) => {
      if (!hasBranchContext(snapshot)) return "branch context not available";
      if (snapshot.contractExists) return "PR contract already initialized";
      return null;
    },
  },
  {
    id: "git.resolve_operation",
    actor: "git",
    surface: "tool",
    label: "Finish in-progress git operation",
    priority: 20,
    command: (snapshot) =>
      snapshot.operation === "rebase"
        ? "git rebase --continue"
        : snapshot.operation === "merge"
          ? "git commit"
          : "git cherry-pick --continue",
    reason: (snapshot) => `Repository has active ${snapshot.operation}`,
    when: (snapshot) => snapshot.operation !== "none",
    disabledReason: (snapshot) =>
      snapshot.operation === "none" ? "no git operation in progress" : null,
  },
  {
    id: "git.resolve_conflicts",
    actor: "git",
    surface: "tool",
    label: "Resolve merge conflicts",
    priority: 30,
    command: () => "git status --porcelain=v1 -b",
    reason: () => "Conflicted files detected in working tree",
    when: (snapshot) => snapshot.local.conflicts > 0,
    disabledReason: (snapshot) =>
      snapshot.local.conflicts === 0 ? "no merge conflicts detected" : null,
  },
  {
    id: "git.commit",
    actor: "git",
    surface: "tool",
    label: "Commit local changes",
    priority: 40,
    command: () => "git add -A && git commit -m '<message>'",
    reason: () => "Local changes exist before PR flow can advance",
    when: (snapshot) =>
      hasBranchContext(snapshot) &&
      !snapshot.pr.exists &&
      (snapshot.local.staged > 0 || snapshot.local.unstaged > 0 || snapshot.local.untracked > 0),
    disabledReason: (snapshot) => {
      if (!hasBranchContext(snapshot)) return "branch context not available";
      if (snapshot.pr.exists) return "pull request already exists";
      if (
        snapshot.local.staged === 0 &&
        snapshot.local.unstaged === 0 &&
        snapshot.local.untracked === 0
      ) {
        return "no local changes to commit";
      }
      return null;
    },
  },
  {
    id: "pr.open",
    actor: "gh",
    surface: "tool",
    label: "Open pull request",
    priority: 50,
    command: () => "gh pr create --draft",
    reason: () => "Branch is pushed and clean but has no open PR",
    when: (snapshot) =>
      hasBranchContext(snapshot) &&
      !snapshot.pr.exists &&
      snapshot.local.staged === 0 &&
      snapshot.local.unstaged === 0,
    disabledReason: (snapshot) => {
      if (!hasBranchContext(snapshot)) return "branch context not available";
      if (snapshot.pr.exists) return "pull request already exists";
      if (snapshot.local.staged > 0 || snapshot.local.unstaged > 0) {
        return "working tree must be clean before opening a pull request";
      }
      return null;
    },
  },
  {
    id: "pr.mark_ready",
    actor: "gh",
    surface: "tool",
    label: "Mark draft PR ready",
    priority: 60,
    command: (snapshot) => formatPrCommand("gh pr ready", snapshot.pr.number),
    reason: () => "PR is still draft",
    when: (snapshot) => hasBranchContext(snapshot) && Boolean(snapshot.pr.exists && snapshot.pr.draft),
    disabledReason: (snapshot) => {
      if (!hasBranchContext(snapshot)) return "branch context not available";
      if (!snapshot.pr.exists) return "pull request does not exist";
      if (!snapshot.pr.draft) return "pull request is already ready for review";
      return null;
    },
  },
  {
    id: "pr.fix_changes",
    actor: "git",
    surface: "skill",
    label: "Address requested changes",
    priority: 70,
    command: () => "prx event --skill pr-fix",
    reason: () => "Review state is changes requested",
    when: (snapshot) => hasBranchContext(snapshot) && snapshot.system.review === "changes_requested",
    disabledReason: (snapshot) => {
      if (!hasBranchContext(snapshot)) return "branch context not available";
      if (snapshot.system.review !== "changes_requested") {
        return "no requested changes to address";
      }
      return null;
    },
  },
  {
    id: "pr.validate",
    actor: "local_ci",
    surface: "skill",
    label: "Run PR validation skill",
    priority: 80,
    command: () => "prx event --skill pr-validate",
    reason: () => "CI is still pending/running",
    when: (snapshot) =>
      hasBranchContext(snapshot) &&
      (snapshot.system.ci === "running" || snapshot.system.ci === "pending"),
    disabledReason: (snapshot) => {
      if (!hasBranchContext(snapshot)) return "branch context not available";
      if (snapshot.system.ci !== "running" && snapshot.system.ci !== "pending") {
        return "CI is not pending or running";
      }
      return null;
    },
  },
  {
    id: "pr.request_review",
    actor: "gh",
    surface: "skill",
    label: "Prepare/request review",
    priority: 90,
    command: () => "prx event --skill pr-ready",
    reason: () => "PR is open but not yet approved",
    when: (snapshot) =>
      hasBranchContext(snapshot) &&
      Boolean(snapshot.pr.exists && !snapshot.pr.draft) &&
      (snapshot.system.review === "none" || snapshot.system.review === "in_review"),
    disabledReason: (snapshot) => {
      if (!hasBranchContext(snapshot)) return "branch context not available";
      if (!snapshot.pr.exists) return "pull request does not exist";
      if (snapshot.pr.draft) return "pull request is still draft";
      if (snapshot.system.review !== "none" && snapshot.system.review !== "in_review") {
        return "review is no longer requestable from the current state";
      }
      return null;
    },
  },
  {
    id: "git.refresh",
    actor: "git",
    surface: "tool",
    label: "Rebase branch onto origin/main",
    priority: 95,
    command: () => "prx worktree refresh",
    reason: () => "Branch is behind origin/main and needs rebase",
    when: (snapshot) =>
      hasBranchContext(snapshot) &&
      snapshot.rawState.signals.mergeability.state === "behind",
    disabledReason: (snapshot) => {
      if (!hasBranchContext(snapshot)) return "branch context not available";
      if (snapshot.rawState.signals.mergeability.state !== "behind")
        return "branch is up to date with base";
      return null;
    },
  },
  {
    id: "git.fetch",
    actor: "git",
    surface: "tool",
    label: "Refresh remote refs",
    priority: 100,
    command: () => "git fetch origin",
    reason: () => "Remote freshness is stale or unknown",
    when: (snapshot) =>
      hasBranchContext(snapshot) &&
      snapshot.system.review === "approved" &&
      (snapshot.remoteFreshness === "stale" || snapshot.remoteFreshness === "unknown"),
    disabledReason: (snapshot) => {
      if (!hasBranchContext(snapshot)) return "branch context not available";
      if (snapshot.system.review !== "approved") return "review has not been approved";
      if (snapshot.remoteFreshness !== "stale" && snapshot.remoteFreshness !== "unknown") {
        return "remote refs are already fresh";
      }
      return null;
    },
  },
  {
    id: "pr.merge",
    actor: "gh",
    surface: "tool",
    label: "Merge PR",
    priority: 110,
    command: (snapshot) =>
      formatPrCommand("gh pr merge", snapshot.pr.number, "--squash", "--delete-branch"),
    reason: () => "Merge gate is satisfied",
    when: (snapshot) => hasBranchContext(snapshot) && Boolean(snapshot.pr.exists && snapshot.mergeReady),
    disabledReason: (snapshot) => {
      if (!hasBranchContext(snapshot)) return "branch context not available";
      if (!snapshot.pr.exists) return "pull request does not exist";
      if (!snapshot.mergeReady) return "merge gate is not satisfied";
      return null;
    },
  },
  {
    id: "pr.next",
    actor: "gh",
    surface: "skill",
    label: "Run PR radar sweep",
    priority: 999,
    command: () => "prx event --skill pr-next",
    reason: () => "No higher-priority action matched",
    when: (snapshot) => hasBranchContext(snapshot) && snapshot.contractExists,
    disabledReason: (snapshot) => {
      if (!hasBranchContext(snapshot)) return "branch context not available";
      if (!snapshot.contractExists) return "PR contract not initialized";
      return null;
    },
  },
  {
    id: "survey.overview",
    actor: "prx",
    surface: "tool",
    label: "Survey PRs",
    priority: 1000,
    command: () => "prx overview",
    reason: () => "No branch context or PR contract — survey-only",
    when: (snapshot) => !hasBranchContext(snapshot) || !snapshot.contractExists,
    disabledReason: (snapshot) =>
      hasBranchContext(snapshot) && snapshot.contractExists
        ? "branch context with contract is available"
        : null,
  },
];

export function resolveActions(snapshot: ActionSnapshot): ResolvedAction[] {
  return actionCatalog
    .sort((a, b) => a.priority - b.priority)
    .map((definition) => {
      const enabled = definition.when(snapshot);
      const disabledReason = enabled ? undefined : (definition.disabledReason(snapshot) ?? "action not currently applicable");
      return {
        id: definition.id,
        actor: definition.actor,
        surface: definition.surface,
        label: definition.label,
        reason: enabled ? definition.reason(snapshot) : undefined,
        command: definition.command(snapshot),
        priority: definition.priority,
        enabled,
        disabledReason,
      };
    });
}

export function nextAction(
  repoPath: string,
  runner?: CommandRunner,
): ActionPlan {
  const snapshot = buildActionSnapshot(repoPath, runner);
  const actions = resolveActions(snapshot);
  return {
    snapshot,
    actions,
    next: actions.find((action) => action.enabled) ?? null,
  };
}
