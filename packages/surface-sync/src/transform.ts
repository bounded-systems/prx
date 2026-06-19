/**
 * The "act" stage: the pure state→action transform. Given a board snapshot +
 * configs (state read by the caller), compute the reconciliation plan as typed
 * intents. No IO, no github.ts reach — stands on its own behind the module
 * boundary (see __tests__/extractability.test.ts). Calls the classifier
 * (`classify`) for per-unit dispositions; everything else is local.
 */

import { classify } from "@bounded-systems/disposition";
import {
  issueParityFeatureEnabled,
  issueFeatureForUnit,
  issueFeatureStatus,
  normalizeIssueStatus,
  githubIssueNumberFromWorkUnitId,
} from "./board-helpers.ts";
import type { BoardSnapshot } from "./snapshot.ts";
import type { SurfaceSyncAction } from "./action.ts";
import type { SurfaceSyncResult } from "./result.ts";
import type { SurfaceSyncMode, SurfaceSyncAuthority, SurfaceSyncScope } from "./scope.ts";
import type { SurfaceSyncConfig } from "./config.ts";
import type { PrefixRoutingConfig } from "./routing.ts";

// Case-fold + trim, mirroring the canonical work-unit-id normalization in
// src/machine/work_unit.ts. Inlined (not imported) so this module stays a
// standalone package: the comparison below only needs both sides folded the
// same way, and pulling work_unit.ts would drag its adapters/triage deps in.
function normalizeWorkUnitId(value: string): string {
  return value.trim().toUpperCase();
}

export function computeSurfaceSync(args: {
  board: BoardSnapshot;
  resolveBufferPath: () => string | null;
  mode: SurfaceSyncMode;
  authority: SurfaceSyncAuthority;
  scope: SurfaceSyncScope;
  apply: boolean;
  mergedOnly: boolean;
  ticketFilter: string | undefined;
  parityConfig: SurfaceSyncConfig;
  routingConfig: PrefixRoutingConfig;
}): SurfaceSyncResult {
  const {
    board,
    resolveBufferPath,
    mode,
    authority,
    scope,
    apply,
    mergedOnly,
    ticketFilter,
    parityConfig,
    routingConfig,
  } = args;

  const candidateUnits = ticketFilter
    ? board.units.filter((unit) => {
        const unitTicket = unit.ticket ? normalizeWorkUnitId(unit.ticket) : null;
        const unitBranch = normalizeWorkUnitId(unit.branch);
        return unitTicket === ticketFilter || unitBranch === ticketFilter;
      })
    : board.units;

  const units = candidateUnits.map((unit) => {
    const actions: SurfaceSyncAction[] = [];
    // GH-2147: operator-facing reasons a completed unit was *not* torn down,
    // surfaced so prune never silently no-ops on a live worktree.
    const blockers: string[] = [];
    const status = unit.status;
    if (!status) {
      return { branch: unit.branch, ticket: unit.ticket, actions };
    }

    const remoteScope = scope === "remote" || scope === "all";
    const localScope = scope === "local" || scope === "all";
    const issueFeature = issueFeatureForUnit(unit.branch, routingConfig);
    const issueFeatureEnabled = issueFeature
      ? issueParityFeatureEnabled(parityConfig, issueFeature)
      : false;
    const issueStatus = issueFeatureStatus(status, issueFeature);
    const normalizedIssueStatus = normalizeIssueStatus(issueStatus, issueFeatureEnabled);
    const disposition = classify({
      status,
      local: unit.local,
      artifacts: unit.artifacts,
      issueFeatureEnabled,
      issueStatus: normalizedIssueStatus,
    });

    // GH-1125: `--merged-only` filter. Only emit `close_issue` when we have
    // positive evidence the issue is open: issue feature is enabled for the
    // unit AND the *normalized* status is explicitly "dirty". A "completed"
    // status means the issue is already closed; "clean" / "disabled" /
    // "unknown" (e.g. gh view failed) all mean we don't have authority to
    // close, so the unit short-circuits with no actions emitted.
    const prCompleted = status.remote.pr === "completed";
    const issueOpen = issueFeatureEnabled && normalizedIssueStatus === "dirty";
    if (mergedOnly && !(prCompleted && issueOpen)) {
      return { branch: unit.branch, ticket: unit.ticket, actions, disposition };
    }

    if (mergedOnly && prCompleted && issueOpen) {
      const issueNumber = unit.ticket ? githubIssueNumberFromWorkUnitId(unit.ticket) : null;
      if (issueNumber !== null) {
        const prNumber = unit.pr.number;
        const prRef = prNumber !== null ? `#${prNumber}` : null;
        actions.push({
          type: "close_issue",
          issue: issueNumber,
          ticket: unit.ticket,
          reason: prRef
            ? `PR ${prRef} merged but issue still open`
            : "linked PR merged but issue still open",
          pr: prNumber,
        });
      }
    }

    if (mode === "prune" || mode === "full") {
      // GH-914: gate `delete_remote_branch` on HEAD authorship. When the
      // operator did not author the remote branch, never enumerate a
      // destructive remote-delete action — `prx chain prune` must not
      // suggest deleting another developer's work just because our local
      // chain doesn't know about it. Unknown authorship (`null`) and
      // operator-authored (`true`) both fall through to the existing
      // emit path; only an explicit `false` suppresses.
      const operatorAuthored = unit.remote_branch_author?.isOperator !== false;
      if (
        remoteScope &&
        status.remote.branch === "dirty" &&
        operatorAuthored &&
        (status.remote.pr === "completed" ||
          (authority === "issue" && issueFeatureEnabled && issueStatus === "completed") ||
          ((!issueFeatureEnabled || issueStatus === "clean" || issueStatus === "disabled") &&
            status.remote.pr === "clean"))
      ) {
        actions.push({
          type: "delete_remote_branch",
          remote: "origin",
          branch: unit.branch,
          ticket: unit.ticket,
          reason:
            status.remote.pr === "completed"
              ? "PR completed but remote branch still differs from origin/main"
              : issueStatus === "completed"
                ? `${issueFeature === "beads_issue" ? "Beads" : "GitHub"} issue completed but remote branch still differs from origin/main`
                : "Remote branch has no issue or PR authority",
        });
      }

      if (
        remoteScope &&
        status.remote.buffer_branch === "dirty" &&
        (status.remote.pr === "completed" ||
          (authority === "issue" && issueFeatureEnabled && issueStatus === "completed") ||
          ((!issueFeatureEnabled || issueStatus === "clean" || issueStatus === "disabled") &&
            status.remote.pr === "clean"))
      ) {
        const bufferPath = resolveBufferPath();
        if (bufferPath) {
          actions.push({
            type: "delete_remote_branch",
            remote: "local",
            branch: unit.branch,
            ticket: unit.ticket,
            reason:
              status.remote.pr === "completed"
                ? "PR completed but local buffer remote still carries the branch"
                : issueStatus === "completed"
                  ? `${issueFeature === "beads_issue" ? "Beads" : "GitHub"} issue completed but local buffer remote still carries the branch`
                  : "Local buffer remote carries a branch with no issue or PR authority",
          });
        }
      }

      if (
        localScope &&
        status.local.dir === "no worktree" &&
        ((issueFeatureEnabled && issueStatus === "completed") || status.remote.pr === "completed")
      ) {
        actions.push({
          type: "delete_local_branch",
          branch: unit.branch,
          ticket: unit.ticket,
          reason: "Completed lifecycle still leaves a local branch without a worktree",
        });
      }

      // GH-1126: when the lifecycle is fully completed (issue closed AND PR
      // merged) but the worktree is still on disk, emit a single
      // `delete_worktree` action routed through
      // `prx worktree-remove --delete-branch`. That verb wraps
      // lock-pid liveness checks and a dirty-tree refusal, so
      // safety lives in one place. Using `unit.ticket ?? unit.branch` lets
      // detached-HEAD worktrees resolve via the basename `gh_<n>_*` matcher
      // in `removeWorktree` (GH-756).
      //
      // Gate on raw state rather than `disposition === "prune"`: the
      // classifier returns `"review"` for any post-merge unit because
      // `status.local.problem === "yes"` triggers when the branch ref has
      // diverged from main (which is the *expected* state immediately after
      // a merge). Mirror the gating shape of the existing
      // `delete_local_branch` and `delete_remote_branch` emits, which also
      // skip the disposition check and read raw lifecycle + worktree state.
      const localOperatorClean =
        (unit.local.staged ?? 0) === 0 &&
        (unit.local.unstaged ?? 0) === 0 &&
        (unit.local.untracked ?? 0) === 0 &&
        (unit.local.conflicts ?? 0) === 0;
      if (
        localScope &&
        status.local.dir === "present" &&
        ((issueFeatureEnabled && issueStatus === "completed") ||
          status.remote.pr === "completed") &&
        localOperatorClean
      ) {
        actions.push({
          type: "delete_worktree",
          branch: unit.branch,
          ticket: unit.ticket,
          reason: "PR merged and issue closed but worktree still on disk",
        });
      }

      // GH-2147 / ai-home-rh8e9: a completed unit whose worktree is still
      // present but ineligible for `delete_worktree` (operator state at risk
      // or a live session) otherwise produces a silent "no actions" result —
      // the operator is left guessing why the merged unit was not cleaned up.
      // Emit an explicit blocker instead. (A *locked* worktree is intentionally
      // left to the apply-time refusal inside `prx worktree-remove`, which
      // already prints an unlock hint; lock state isn't on the board snapshot.)
      const lifecycleCompleted =
        (issueFeatureEnabled && issueStatus === "completed") || status.remote.pr === "completed";
      if (localScope && status.local.dir === "present" && lifecycleCompleted) {
        const target = unit.ticket ?? unit.branch;
        if (!localOperatorClean) {
          blockers.push(
            `worktree has uncommitted changes — refusing to prune. Commit or stash, then re-run; or remove manually with \`prx worktree-remove ${target}\`.`,
          );
        }
      }
    }

    if (mode === "backfill" || mode === "full") {
      const authorityActive =
        authority === "issue"
          ? issueFeatureEnabled && issueStatus === "dirty"
          : authority === "pr"
            ? status.remote.pr === "dirty"
            : status.local.branch === "dirty" ||
              status.local.dir === "no worktree" ||
              status.local.dir === "present" ||
              status.local.dir === "wrong worktree";

      if (localScope && authorityActive && status.local.dir === "missing" && unit.ticket) {
        actions.push({
          type: "create_local_branch",
          branch: unit.branch,
          ticket: unit.ticket,
          reason: "Issue exists but local branch is missing",
        });
      }

      if (localScope && authorityActive && status.local.dir === "no worktree") {
        actions.push({
          type: "create_worktree",
          branch: unit.branch,
          ticket: unit.ticket,
          reason: "Local branch exists but no worktree is attached",
        });
      }

      if (
        remoteScope &&
        authorityActive &&
        (status.local.dir === "present" ||
          status.local.dir === "wrong worktree" ||
          status.local.dir === "no worktree") &&
        status.remote.branch === "missing"
      ) {
        actions.push({
          type: "push_remote_branch",
          branch: unit.branch,
          ticket: unit.ticket,
          reason: "Local branch exists but remote branch is missing",
        });
      }

      if (
        remoteScope &&
        authorityActive &&
        status.remote.branch === "dirty" &&
        status.remote.pr === "clean"
      ) {
        actions.push({
          type: "open_pr",
          branch: unit.branch,
          ticket: unit.ticket,
          reason: "Remote branch exists without an open PR",
        });
      }
    }

    return {
      branch: unit.branch,
      ticket: unit.ticket,
      actions,
      disposition,
      ...(blockers.length > 0 ? { blockers } : {}),
    };
  });

  const allActions = units.flatMap((unit) => unit.actions);

  return {
    source: "surface-sync",
    repo: board.repo,
    mode,
    authority,
    scope,
    apply,
    ...(ticketFilter ? { ticket: ticketFilter } : {}),
    units,
    actions: allActions,
  };
}
