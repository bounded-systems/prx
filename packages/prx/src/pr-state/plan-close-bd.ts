/**
 * `prx plan close` driver + (formerly) bd-record close-and-verify.
 *
 * GH-1012: the bd write plane has been removed. GitHub
 * is now the sole write plane and `gh issue close` (in `planClose` below) is the
 * canonical close for a work unit; Front Desk is the read plane. There are no bd
 * records left to close-and-verify, so the former `resolveAndCloseLinkedBeads`
 * close-and-verify pass is now a no-op kept only so the driver's output shape and
 * the exported types stay stable for downstream callers (cli.ts / cli-format.ts /
 * plan-close-verb.ts).
 */

// `prx plan close` driver deps (moved with planClose from cli.ts).
import {
  defaultRunner,
  repoNameWithOwner,
  viewIssueFresh,
  type CommandRunner as GithubCommandRunner,
} from "./github.ts";
import { runBeadsSync } from "../sync/run.ts";
import { DEFAULT_SYNC_LIMIT } from "../sync/limits.ts";
import { invalidateUnit } from "./projection.ts";

// Local copy of the `PlanCloseReason` union exported from `./cli.ts`. Inlined
// (rather than imported) to avoid a circular module dependency — cli.ts will
// import the helper below.
export type PlanCloseReason = "completed" | "not-planned" | "duplicate";

export type PlanCloseBdPerId =
  | { id: string; kind: "closed" }
  | { id: string; kind: "skip:already-closed" }
  | { id: string; kind: "error"; detail: string };

/** Result of the bd-record close-and-verify pass for a single `plan close` call. */
export type PlanCloseBdRecordOutcome = {
  /** Plain-format value shown after `bd_record=`. */
  outcome: string;
  /**
   * Whether the verb should treat this outcome as success. `skip:no-bead-link`
   * and `skip:already-closed` count as success — the work unit is in a
   * coherent state and no follow-up close is needed.
   */
  ok: boolean;
  /** Per-bead detail; empty when no beads were linked. */
  perId: PlanCloseBdPerId[];
};

/**
 * Result of a `prx plan close` run. Lives here (next to the `planClose` driver
 * that produces it) rather than in cli-types so the two don't form an import
 * cycle — `PlanCloseResult` references `PlanCloseBdRecordOutcome` above.
 */
export type PlanCloseResult = {
  workUnitId: string;
  issueNumber: number | null;
  reason: PlanCloseReason;
  upstream: string | null;
  upstreamCommentPosted: boolean;
  issueClosed: boolean;
  /**
   * Outcome of the (now no-op, GH-1012) bd-record close-and-verify pass. Kept
   * for output-shape stability; always reports the `skip:no-bead-link` success
   * outcome since there is no bd write plane to close against.
   */
  bdRecord: PlanCloseBdRecordOutcome | null;
  /**
   * Exit code from the canonical reconcile tick (`runBeadsSync`). "did the
   * periodic-reconcile shell out cleanly?".
   */
  bdSyncExitCode: number | null;
  handoff: string[];
  refusalReason: string | null;
  dryRun: boolean;
};

/**
 * Translate the canonical `prx plan close --reason` surface to a
 * `close_reason` slot. Parallel to `planCloseReasonToGhReason`. Distinguishes
 * plan-close provenance from the postmerge sweep's `"closed-by-pull"`.
 */
export function planCloseReasonToBdReason(reason: PlanCloseReason): string {
  return `closed-by-plan-${reason}`;
}

export type ResolveAndCloseLinkedBeadsOptions = {
  issueNumber: number;
  reason: PlanCloseReason;
  cwd: string;
};

/**
 * GH-1012 no-op. The bd write plane is gone — GitHub is the sole write plane and
 * `planClose`'s `gh issue close` is the canonical close for a work unit, so there
 * are no linked bd records to close-and-verify. Retained (and still exported) so
 * the driver's output shape and downstream imports stay stable; always reports
 * the `skip:no-bead-link` success outcome.
 */
export async function resolveAndCloseLinkedBeads(
  _opts: ResolveAndCloseLinkedBeadsOptions,
): Promise<PlanCloseBdRecordOutcome> {
  return { outcome: "skip:no-bead-link", ok: true, perId: [] };
}

// ── `prx plan close` driver (moved from pr-state/cli.ts, GH-1057) ─────────────
// GH-1057: `prx plan close` — operator-context wrapper for issue
// close-without-merge. Distinct from `closeSession` (post-merge cleanup) in
// that this verb actually invokes `gh issue close` with a structured reason
// + optional upstream-pointer comment. Carries actor identity for hooks gating
// raw `gh issue close` from non-plan profiles.
// GH-1720: `gh issue close --reason` accepts {completed|not planned|duplicate}
// (space form). Our canonical surface is hyphen form per
// feedback_no_raw_gh_close. Translate at the spawn boundary only.
export function planCloseReasonToGhReason(reason: PlanCloseReason): string {
  return reason === "not-planned" ? "not planned" : reason;
}

export type PlanCloseOptions = {
  workUnitId: string;
  reason: PlanCloseReason;
  upstream: string | null;
  dryRun: boolean;
  emitNext: boolean;
};
export type PlanCloseDeps = {
  cwd?: string;
  runner?: GithubCommandRunner;
  /**
   * Canonical reconcile (GH-2011: replaces the retired `bdSync` slot that
   * dispatched the bd-side reconcile shell-out). Tests override this seam
   * to assert the chain is invoked.
   */
  beadsSync?: typeof runBeadsSync;
};

export async function planClose(
  options: PlanCloseOptions,
  deps: PlanCloseDeps = {},
): Promise<PlanCloseResult> {
  const cwd = deps.cwd ?? process.cwd();
  const runner = deps.runner ?? defaultRunner;
  const beadsSync = deps.beadsSync ?? runBeadsSync;

  const issueNumberMatch = options.workUnitId.match(/-(\d+)$/);
  const issueNumber = issueNumberMatch ? Number(issueNumberMatch[1]) : null;

  const baseResult: PlanCloseResult = {
    workUnitId: options.workUnitId,
    issueNumber,
    reason: options.reason,
    upstream: options.upstream,
    upstreamCommentPosted: false,
    issueClosed: false,
    bdRecord: null,
    bdSyncExitCode: null,
    handoff: [`prx worktree-remove ${options.workUnitId} --delete-branch --force`],
    refusalReason: null,
    dryRun: options.dryRun,
  };
  if (options.emitNext) {
    baseResult.handoff.push("prx delegate next");
  }

  if (issueNumber === null) {
    return {
      ...baseResult,
      refusalReason: `cannot extract issue number from ${options.workUnitId}`,
    };
  }

  const repoSlug = repoNameWithOwner(cwd, runner);

  // Idempotency: skip if already closed. Surface as refusal so re-runs from a
  // shell hook don't silently no-op.
  const issue = viewIssueFresh(repoSlug, options.workUnitId, runner);
  const issueState = issue ? (issue.state ?? "").toUpperCase() : null;
  if (issueState === "CLOSED") {
    return {
      ...baseResult,
      refusalReason: `issue #${issueNumber} is already closed`,
    };
  }

  if (options.dryRun) {
    return baseResult;
  }

  let upstreamCommentPosted = false;
  if (options.upstream) {
    const body =
      `Closing in favor of upstream: ${options.upstream}\n\n` + `Reason: ${options.reason}`;
    const commentResult = runner(
      ["gh", "issue", "comment", String(issueNumber), "--repo", repoSlug, "--body", body],
      { check: false },
    );
    if (commentResult.status !== 0) {
      return {
        ...baseResult,
        refusalReason:
          `failed to post upstream pointer comment: ` +
          (commentResult.stderr || commentResult.stdout || "unknown error").trim(),
      };
    }
    upstreamCommentPosted = true;
  }

  const closeResult = runner(
    [
      "gh",
      "issue",
      "close",
      String(issueNumber),
      "--repo",
      repoSlug,
      "--reason",
      planCloseReasonToGhReason(options.reason),
    ],
    { check: false },
  );
  if (closeResult.status !== 0) {
    return {
      ...baseResult,
      upstreamCommentPosted,
      refusalReason:
        `gh issue close failed: ` +
        (closeResult.stderr || closeResult.stdout || "unknown error").trim(),
    };
  }

  // GH-1012: bd-record close-and-verify is now a no-op (the bd write plane is
  // gone; `gh issue close` above is the canonical close). Kept in the chain so
  // the output shape stays stable.
  const bdRecord = await resolveAndCloseLinkedBeads({ issueNumber, reason: options.reason, cwd });

  // GH-2011: chain the canonical reconcile. Reconcile lag is still expected —
  // surface the exit code so the caller can re-run.
  const repoSlugTrimmed = repoSlug.trim();
  const syncResult = await beadsSync(
    {
      repo: repoSlugTrimmed.length > 0 ? repoSlugTrimmed : undefined,
      domain: "gh",
      dryRun: false,
      limit: DEFAULT_SYNC_LIMIT,
      format: "plain",
    },
    { log: () => {}, error: () => {} },
    { cwd: () => cwd },
  );

  // GH-2074 PR-3: this actor just mutated the unit — the GH issue is now closed.
  // Drop the unit's read-projection entries so a subsequent read re-hydrates
  // fresh instead of serving the stale pre-close ("open") state within the TTL
  // window (ai-home-udqx2.12 self-mutation invalidation). Best-effort; a missing
  // entry is a no-op.
  invalidateUnit(repoSlug, options.workUnitId);
  for (const per of bdRecord.perId ?? []) {
    invalidateUnit(cwd, per.id);
  }

  return {
    ...baseResult,
    upstreamCommentPosted,
    issueClosed: true,
    bdRecord,
    bdSyncExitCode: syncResult.exitCode,
  };
}
