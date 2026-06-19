/**
 * GH-2110: bd-record close-and-verify for `prx plan close`.
 *
 * Resolves bead(s) linked to a GH issue number, closes any still-open ones via
 * the narrow `bd close` wrapper, and re-reads with `bd show` to confirm the
 * status transition actually landed. Mirrors the loop shape in
 * `src/submit/postmerge.ts` (close-and-verify), but stays its own helper
 * because the resolution path here is "lookup by GH issue number" rather than
 * the postmerge "scan refs in PR body".
 *
 * Why this exists separately from the reconcile chain (`runBeadsSync`): the
 * reconcile tick can return `exitCode=0` even when a per-pair close was
 * deferred — pinned-pair gating, `--limit` budget, GH eventual-consistency
 * lag. `prx plan close` is the canonical close *actor* for this work unit, so
 * it owns an end-of-line write here rather than relying on the periodic
 * reconcile to eventually catch up.
 */

import {
  execBdIssueClose as defaultExecBdIssueClose,
  type BdIssueCloseResult,
} from "../tools/bd_issue_close.ts";
import {
  runBdShow as defaultBdShow,
  type BdShowResult,
  type BdGithubRunner,
} from "@bounded-systems/bd";
import { loadAllBeads as defaultLoadAllBeads, type BeadsRecord } from "../triage/triage.ts";
import { buildBeadsLookup } from "../issues/dedupe.ts";
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
   * coherent state and no follow-up `bd close` is needed.
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
   * GH-2110: outcome of the bd-record close-and-verify pass that runs after
   * `gh issue close` succeeds. The headline operator-facing signal — distinct
   * from `bdSyncExitCode` (the broader reconcile tick), which can still
   * report `ok` even when this pass leaves the linked bd record open.
   */
  bdRecord: PlanCloseBdRecordOutcome | null;
  /**
   * Exit code from the canonical reconcile tick (`runBeadsSync`). Narrower
   * meaning post-GH-2110 — "did the periodic-reconcile shell out cleanly?",
   * not "is the linked bd record CLOSED?". The latter is `bdRecord`.
   */
  bdSyncExitCode: number | null;
  handoff: string[];
  refusalReason: string | null;
  dryRun: boolean;
};

/**
 * Translate the canonical `prx plan close --reason` surface to a bd
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

export type ResolveAndCloseLinkedBeadsDeps = {
  execBdIssueClose?: typeof defaultExecBdIssueClose | undefined;
  bdShow?: typeof defaultBdShow | undefined;
  loadAllBeads?: (() => BeadsRecord[]) | undefined;
};

export async function resolveAndCloseLinkedBeads(
  opts: ResolveAndCloseLinkedBeadsOptions,
  deps: ResolveAndCloseLinkedBeadsDeps = {},
): Promise<PlanCloseBdRecordOutcome> {
  const execClose = deps.execBdIssueClose ?? defaultExecBdIssueClose;
  const show = deps.bdShow ?? defaultBdShow;
  const load = deps.loadAllBeads ?? (() => defaultLoadAllBeads());

  let beads: BeadsRecord[];
  try {
    beads = load();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      outcome: `error:load-beads-failed:${truncate(detail)}`,
      ok: false,
      perId: [],
    };
  }

  const lookup = buildBeadsLookup(beads);
  const hit = lookup.byIssueNumber.get(opts.issueNumber);

  if (!hit) {
    return { outcome: "skip:no-bead-link", ok: true, perId: [] };
  }

  // Single-bead path is the common case. We still keep the per-id list for
  // JSON parity with the multi path. (Multi-bead linkage to one GH issue is
  // rare but reachable when two beads share an `external_ref` post-dedupe.)
  const linkedIds = collectLinkedBeadIds(beads, opts.issueNumber);
  const bdReason = planCloseReasonToBdReason(opts.reason);

  const perId: PlanCloseBdPerId[] = [];
  for (const id of linkedIds) {
    perId.push(closeAndVerify(id, opts.cwd, bdReason, show, execClose));
  }

  return summarize(perId);
}

function collectLinkedBeadIds(beads: BeadsRecord[], issueNumber: number): string[] {
  const ids: string[] = [];
  for (const record of beads) {
    if (record.externalIssueNumber === issueNumber) {
      ids.push(record.id);
    }
  }
  return ids;
}

function closeAndVerify(
  id: string,
  cwd: string,
  reason: string,
  show: typeof defaultBdShow,
  execClose: typeof defaultExecBdIssueClose,
): PlanCloseBdPerId {
  const initial: BdShowResult = show(id, cwd);
  if (!initial.ok) {
    return {
      id,
      kind: "error",
      detail: `bd-show:${truncate(initial.stderr.trim() || initial.stdout.trim() || "failed")}`,
    };
  }
  if (initial.record.status.toLowerCase() === "closed") {
    return { id, kind: "skip:already-closed" };
  }

  const close: BdIssueCloseResult = execClose({ id, cwd, reason });
  if (close.exitCode !== 0) {
    return {
      id,
      kind: "error",
      detail: `bd-close:${truncate(close.stderr.trim() || close.stdout.trim() || "failed")}`,
    };
  }

  // Re-read to verify the transition actually landed. This is the GH-2110
  // symptom guard: `bd close` can exit 0 while the bd record stays in a
  // non-closed status if the write was a no-op or got rolled back.
  const verify: BdShowResult = show(id, cwd);
  if (!verify.ok) {
    return {
      id,
      kind: "error",
      detail: `bd-show-verify:${truncate(verify.stderr.trim() || verify.stdout.trim() || "failed")}`,
    };
  }
  if (verify.record.status.toLowerCase() !== "closed") {
    return {
      id,
      kind: "error",
      detail: `state-not-closed:${verify.record.status.toLowerCase() || "unknown"}`,
    };
  }
  return { id, kind: "closed" };
}

function summarize(perId: PlanCloseBdPerId[]): PlanCloseBdRecordOutcome {
  if (perId.length === 1) {
    const only = perId[0]!;
    if (only.kind === "closed") return { outcome: "closed", ok: true, perId };
    if (only.kind === "skip:already-closed") {
      return { outcome: "skip:already-closed", ok: true, perId };
    }
    return { outcome: `error:${only.detail}`, ok: false, perId };
  }

  const total = perId.length;
  const closedCount = perId.filter(
    (p) => p.kind === "closed" || p.kind === "skip:already-closed",
  ).length;
  const ok = perId.every((p) => p.kind !== "error");
  return {
    outcome: `multi:${closedCount}/${total}`,
    ok,
    perId,
  };
}

const TRUNCATE_LEN = 80;
function truncate(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= TRUNCATE_LEN) return collapsed;
  return `${collapsed.slice(0, TRUNCATE_LEN - 1)}…`;
}

// ── `prx plan close` driver (moved from pr-state/cli.ts, GH-1057) ─────────────
// GH-1057: `prx plan close` — operator-context wrapper for issue
// close-without-merge. Distinct from `closeSession` (post-merge cleanup) in
// that this verb actually invokes `gh issue close` with a structured reason
// + optional upstream-pointer comment, then runs `bd github sync` to mirror
// the closed state into beads. Carries actor identity for hooks gating raw
// `gh issue close` from non-plan profiles.
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
  bdRunner?: BdGithubRunner;
  /**
   * Canonical reconcile (GH-2011: replaces the retired `bdSync` slot that
   * dispatched the bd-side reconcile shell-out). Tests override this seam
   * to assert the chain is invoked.
   */
  beadsSync?: typeof runBeadsSync;
  /**
   * GH-2110: bd-record close seams. Tests inject stubs to assert the
   * close-and-verify shape without spawning bd. Production wires the
   * defaults from `tools/bd_issue_close.ts` + `tools/bd.ts` + `triage.ts`.
   */
  execBdIssueClose?: typeof defaultExecBdIssueClose;
  bdShow?: typeof defaultBdShow;
  loadAllBeads?: () => BeadsRecord[];
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

  // GH-2110: end-of-line bd-record close-and-verify. Done by the close *actor*
  // for this work unit so the operator-visible outcome reflects the linked bd
  // record's actual status — the reconcile chain below can return 0 while
  // skipping per-pair closes (unpinned, limit, eventual-consistency lag), and
  // the previous `bd_sync=ok` line did not distinguish those cases from a
  // landed close.
  const bdRecord = await resolveAndCloseLinkedBeads(
    { issueNumber, reason: options.reason, cwd },
    {
      execBdIssueClose: deps.execBdIssueClose,
      bdShow: deps.bdShow,
      loadAllBeads: deps.loadAllBeads,
    },
  );

  // GH-2011: chain the canonical reconcile rather than the destructive bd
  // verb. Reconcile lag is still expected — surface the exit code so the
  // caller can re-run.
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

  // GH-2074 PR-3: this actor just mutated the unit — the GH issue and its
  // linked beads are now closed. Drop the unit's read-projection entries so a
  // subsequent read re-hydrates fresh instead of serving the stale pre-close
  // ("open") state within the TTL window (ai-home-udqx2.12 self-mutation
  // invalidation). Best-effort; a missing entry is a no-op.
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
