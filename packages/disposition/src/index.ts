/**
 * The "label" actor: a pure classifier mapping a work unit's surface state to
 * a disposition (`ok | prune | repair | review`). A decision table, not XState.
 *
 * Side-effect-free and **self-contained** — it owns its input contract
 * (`ClassifyInput`) rather than importing github.ts's `BoardUnit`, so it stands
 * on its own as the labeling stage between extract (scout) and act
 * (surface-sync). See docs/architecture/standalone-modules.md.
 */
import { z } from "zod";

export const dispositionSchema = z.enum(["ok", "prune", "repair", "review"]);
export type Disposition = z.infer<typeof dispositionSchema>;

/**
 * Input contract for the classifier — the minimal surface state it labels.
 * Any richer board-unit shape (github's `BoardUnit`, a scout snapshot unit)
 * structurally satisfies it.
 */
export type ClassifyInput = {
  status: {
    remote: { problem: string; pr: string; branch: string };
    local: { problem: string; branch: string; dir: string };
  };
  local: {
    staged: number | null;
    unstaged: number | null;
    untracked: number | null;
    conflicts: number | null;
  };
  artifacts: { worktree: boolean; branch: boolean; pr: boolean };
  tmux: { present: boolean; sessionName: string | null; conflicted?: boolean | undefined };
  issueFeatureEnabled: boolean;
  /**
   * `clean` / `dirty` / `completed` from `status.remote.gh_issue` (or
   * `beads_issue` for routed prefixes); `disabled` when the feature is
   * off and we have no authority to consult.
   */
  issueStatus: "clean" | "dirty" | "completed" | "disabled";
};

function localOperatorStateClean(local: ClassifyInput["local"]): boolean {
  const staged = local.staged ?? 0;
  const unstaged = local.unstaged ?? 0;
  const untracked = local.untracked ?? 0;
  const conflicts = local.conflicts ?? 0;
  return staged === 0 && unstaged === 0 && untracked === 0 && conflicts === 0;
}

export function classify(input: ClassifyInput): Disposition {
  const { status, tmux, issueFeatureEnabled, issueStatus, artifacts, local } = input;

  // Structural/authority ambiguity → review. Operator must adjudicate.
  if (status.remote.problem === "yes" || status.local.problem === "yes") {
    return "review";
  }

  // Multiple sessions for the same work unit is a structural conflict.
  if (tmux.conflicted) {
    return "review";
  }

  const issueCompleted = issueFeatureEnabled && issueStatus === "completed";
  const prCompleted = status.remote.pr === "completed";
  const localClean = localOperatorStateClean(local);

  // Prune: terminal lifecycle on every authority + no operator state to lose.
  if (
    issueCompleted
    && prCompleted
    && localClean
    && !tmux.present
  ) {
    return "prune";
  }

  // Closed authority but not fully wound down → review (operator state at risk).
  if (issueCompleted || prCompleted) {
    return "review";
  }

  const issueActive = issueFeatureEnabled && issueStatus === "dirty";
  const prActive = status.remote.pr === "dirty";
  const authorityActive = issueActive || prActive;

  if (!authorityActive) {
    // No authority asserts this row exists. Ambiguous unless everything is
    // already cleared up.
    if (
      !artifacts.worktree
      && status.local.branch !== "dirty"
      && status.remote.branch !== "dirty"
    ) {
      return "ok";
    }
    return "review";
  }

  // Authority active. Compute parity per surface against the "all five
  // present" expectation: worktree + local branch + remote branch + PR + tmux.
  //
  // Presence semantics:
  //   local.branch: "missing" = no branch; "clean"/"dirty" = branch exists
  //     (note: "clean" is also returned when !branchExists, so use artifacts.branch)
  //   remote.branch: "missing" = ref not on remote; "clean"/"dirty" = ref exists
  //   remote.pr: "clean" = NO PR; "dirty" = open PR; "completed" = merged/closed
  const worktreePresent = artifacts.worktree && status.local.dir === "present";
  const localBranchPresent = artifacts.branch;
  const remoteBranchPresent = status.remote.branch !== "missing";
  const prPresent = status.remote.pr === "dirty" && artifacts.pr;
  const tmuxPresent = tmux.present;

  if (worktreePresent && localBranchPresent && remoteBranchPresent && prPresent && tmuxPresent) {
    return "ok";
  }

  // Repair only when there's no operator state at risk (clean local, or only
  // tmux missing). Otherwise the operator should look at it.
  const onlyTmuxMissing =
    worktreePresent && localBranchPresent && remoteBranchPresent && prPresent && !tmuxPresent;
  if (onlyTmuxMissing) {
    return "repair";
  }

  if (localClean) {
    return "repair";
  }

  return "review";
}
