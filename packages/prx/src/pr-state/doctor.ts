/**
 * `prx doctor` — PR readiness diagnostician (GH-885 + GH-882).
 *
 * The doctor is a verification_publication-tier actor that reads PR state
 * via `gh`. Sibling to `gh` / `local_ci` / `remote_ci` / `publisher`.
 *
 * Surface:
 *   prx doctor inventory [GH-NNN] — typed snapshot + per-verb gate breakdown
 *
 * GH-1559 (GH-1398 ADR §4): the publication-transition verbs `merge` /
 * `ready` / `draft` moved to the `publisher` actor (`./publisher.ts`), which
 * owns those intents in the machine catalog. `doctor` keeps the read-only
 * `inventory` verb plus the shared gate primitives those verbs build on:
 * `loadInventory`, `gateTransition`, `partitionBlockers`, and the
 * `Doctor*` types. `prx doctor merge|ready|draft` remain one release window
 * as deprecation aliases that delegate to the publisher handlers (cli.ts).
 *
 * Gates mirror invariant **I04**:
 *   phase=ready_to_merge => approved && ci passed && mergeable && remoteFresh
 *                          && unresolvedThreads==0 && !draft
 */

import {
  type CommandRunner,
  convertPrToDraft,
  defaultRunner,
  enableAutoMerge,
  fetchBranchProtection,
  fetchPrComments,
  type LiveBranchProtection,
  markPrReadyForReview,
  mergePullRequest,
  type PrCommentsResult,
  resolvePrNodeId,
} from "./github.ts";
import type { ProvenanceAxis } from "./machine.ts";

export type DoctorTarget = {
  workUnitId: string;
  repoPath: string;
  prRef?: string;
};

export type DoctorMergeMethod = "MERGE" | "SQUASH" | "REBASE";

export type DoctorMergeOptions = {
  method?: DoctorMergeMethod;
  noUpdateBranch?: boolean;
};

/**
 * GH-1354: blockers partition into hard blockers (operator action required;
 * the underlying mutation would either reject outright or sit forever) and
 * waiting conditions (transient signals that `enablePullRequestAutoMerge`
 * is designed to queue through). Only hard blockers veto the gate.
 */
export type DoctorBlockerClass = "blocker" | "waiting";

export type DoctorBlocker = {
  predicate: string;
  fixHint: string;
  class: DoctorBlockerClass;
};

export type DoctorGateResult = {
  ok: boolean;
  blockers: DoctorBlocker[];
};

/**
 * GH-1346: per-disposition resolution for the merge gate's review-decision
 * clause. `enforced` = GitHub branch protection requires ≥1 approval (or code
 * owner reviews); `skipped` = GitHub itself requires no approval, so the
 * doctor mirrors that posture instead of being stricter.
 */
export type DoctorReviewGateDisposition = "enforced" | "skipped";

export type DoctorVerb = "inventory" | "merge" | "ready" | "draft";

export type DoctorInventory = {
  prNumber: number;
  prUrl: string;
  prTitle: string;
  isDraft: boolean;
  baseRefName: string;
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  mergeable: string | null;
  ciState: "passed" | "failed" | "queued" | "in_progress" | "unknown";
  unresolvedThreads: number;
  behindBy: number;
  autoMergeEnabled: boolean;
  autoMergeMethod: DoctorMergeMethod | null;
  autoMergeEnabledBy: string | null;
  // GH-1346: live branch protection on baseRefName. `null` means GitHub has
  // no protection rule on that branch — the merge gate then can't enforce a
  // review decision GitHub itself wouldn't enforce.
  protection: LiveBranchProtection | null;
  // GH-2249 (I-PROV1): merge-guard signed-derivation verdict for the head
  // commit, computed upstream by the async provenance projection and injected
  // via `DoctorDeps.provenanceAxis`. Absent / "unchecked" / "verified" never
  // block; only "unsigned" does (see `gateTransition`). The gate stays
  // synchronous — the ledger I/O happens before the inventory is gated.
  provenance?: ProvenanceAxis;
};

export type DoctorOutput = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type DoctorDeps = {
  fetchPrComments?: typeof fetchPrComments;
  fetchBranchProtection?: typeof fetchBranchProtection;
  resolvePrNodeId?: typeof resolvePrNodeId;
  enableAutoMerge?: typeof enableAutoMerge;
  mergePullRequest?: typeof mergePullRequest;
  markPrReadyForReview?: typeof markPrReadyForReview;
  convertPrToDraft?: typeof convertPrToDraft;
  runner?: CommandRunner;
  // GH-2249 (I-PROV1): the merge-guard provenance verdict, resolved by the
  // async projection at the dispatch layer (which can do ledger I/O) and
  // stamped onto the inventory here. Absent ⇒ the gate is unchanged. Injected
  // rather than computed inline so the gate + run functions stay synchronous.
  provenanceAxis?: ProvenanceAxis;
};

export class DoctorError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "DoctorError";
    this.exitCode = exitCode;
  }
}

function projectInventory(
  comments: PrCommentsResult,
  behindBy: number,
  protection: LiveBranchProtection | null,
): DoctorInventory {
  // Derive a coarse CI bucket from gh's mergeStateStatus and mergeable. The
  // raw graph (`StatusCheckRollup`) is richer but the gate only needs
  // pass/fail/in-flight. `mergeStateStatus` of CLEAN implies passing checks;
  // BLOCKED can be either failing checks or unresolved threads — we already
  // surface threads separately, so BLOCKED collapses to "unknown" for CI.
  const status = comments.pr.mergeStateStatus;
  let ciState: DoctorInventory["ciState"] = "unknown";
  if (status === "CLEAN" || status === "HAS_HOOKS" || status === "UNSTABLE") {
    ciState = "passed";
  } else if (status === "DIRTY") {
    ciState = "failed";
  } else if (status === "BLOCKED") {
    // Default to "passed" so the gate's blocker list reflects the real cause
    // (unresolved threads / approvals) rather than a CI false positive.
    ciState = comments.unresolvedThreads > 0 ? "passed" : "failed";
  }

  return {
    prNumber: comments.pr.number,
    prUrl: comments.pr.url,
    prTitle: comments.pr.title,
    isDraft: comments.pr.isDraft,
    baseRefName: comments.pr.baseRefName,
    reviewDecision: comments.pr.reviewDecision,
    mergeStateStatus: comments.pr.mergeStateStatus,
    mergeable: comments.pr.mergeable,
    ciState,
    unresolvedThreads: comments.unresolvedThreads,
    behindBy,
    autoMergeEnabled: comments.pr.autoMergeEnabled,
    autoMergeMethod: comments.pr.autoMergeRequest?.mergeMethod ?? null,
    autoMergeEnabledBy: comments.pr.autoMergeRequest?.enabledBy ?? null,
    protection,
  } satisfies DoctorInventory;
}

export function reviewGateDisposition(
  protection: LiveBranchProtection | null,
): DoctorReviewGateDisposition {
  if (protection === null) return "skipped";
  if (protection.requiredApprovingReviewCount > 0) return "enforced";
  if (protection.requireCodeOwnerReviews) return "enforced";
  return "skipped";
}

function deriveBehindBy(comments: PrCommentsResult): number {
  // mergeStateStatus=BEHIND means the head branch is behind the base; we
  // surface that as a non-zero count so callers can drive the auto-update
  // path. The exact numeric is not exposed by gh pr view today — 1 is the
  // smallest signal that "an update is needed".
  return comments.pr.mergeStateStatus === "BEHIND" ? 1 : 0;
}

export function loadInventory(
  target: DoctorTarget,
  deps: DoctorDeps = {},
): DoctorInventory {
  const fetcher = deps.fetchPrComments ?? fetchPrComments;
  const protectionFetcher = deps.fetchBranchProtection ?? fetchBranchProtection;
  const runner = deps.runner ?? defaultRunner;
  const comments = fetcher(target.repoPath, target.prRef ?? target.workUnitId, runner);
  const protection = protectionFetcher(target.repoPath, comments.pr.baseRefName, runner);
  const inventory = projectInventory(comments, deriveBehindBy(comments), protection);
  // GH-2249: stamp the injected merge-guard verdict (computed upstream by the
  // async projection). Absent ⇒ the gate is unchanged.
  return deps.provenanceAxis === undefined
    ? inventory
    : { ...inventory, provenance: deps.provenanceAxis };
}

export function gateTransition(
  verb: DoctorVerb,
  inventory: DoctorInventory,
): DoctorGateResult {
  const blockers: DoctorBlocker[] = [];

  if (verb === "draft") {
    // Draft has no gate — converting back to draft is always safe.
    return { ok: true, blockers: [] };
  }

  if (verb === "ready") {
    // Light gate: don't promote to ready while CI is failing or threads are
    // unresolved (would just bounce back to changes_requested or blocked).
    if (inventory.ciState === "failed") {
      blockers.push({
        predicate: "ci.state=failed",
        fixHint: `fix the failing checks (PR ${inventory.prUrl}) before \`prx publisher ready\``,
        class: "blocker",
      });
    }
    if (inventory.unresolvedThreads > 0) {
      blockers.push({
        predicate: `signals.review.unresolvedThreads=${inventory.unresolvedThreads}`,
        fixHint: "resolve the open review threads on GitHub or via the contract before promoting to ready",
        class: "blocker",
      });
    }
    pushProvenanceBlocker(blockers, inventory);
    return { ok: hardBlockerCount(blockers) === 0, blockers };
  }

  // verb === "merge" — full I04 gate, partitioned per GH-1354.
  if (inventory.isDraft) {
    // Hard: enablePullRequestAutoMerge rejects drafts outright.
    blockers.push({
      predicate: "pr.isDraft=true",
      fixHint: "run `prx publisher ready` to lift the PR out of draft before merging",
      class: "blocker",
    });
  }
  // GH-1346: only enforce the review-decision clause when GitHub itself
  // would. GH-1354: when enforced, treat as a *waiting* condition rather
  // than a hard blocker — `enablePullRequestAutoMerge` queues safely until
  // the approval lands and fires automatically.
  if (
    reviewGateDisposition(inventory.protection) === "enforced"
    && inventory.reviewDecision !== "APPROVED"
  ) {
    blockers.push({
      predicate: `signals.review.decision=${inventory.reviewDecision ?? "none"}`,
      fixHint: "automerge will queue and fire once an APPROVED review lands",
      class: "waiting",
    });
  }
  if (inventory.ciState === "failed") {
    // Hard: required checks won't pass without a code change.
    blockers.push({
      predicate: "signals.ci.state=failed",
      fixHint: "fix the failing required checks before enabling automerge",
      class: "blocker",
    });
  } else if (inventory.ciState !== "passed") {
    // Waiting: queued / in_progress / unknown — automerge is built for this.
    blockers.push({
      predicate: `signals.ci.state=${inventory.ciState}`,
      fixHint: "automerge will queue and fire when required checks pass",
      class: "waiting",
    });
  }
  if (inventory.unresolvedThreads > 0) {
    // Hard by operator preference (GH-1354): keep "resolve before queueing"
    // habit rather than letting threads hide behind a queued mutation.
    blockers.push({
      predicate: `signals.review.unresolvedThreads=${inventory.unresolvedThreads}`,
      fixHint: "resolve the remaining review threads on GitHub before enabling automerge",
      class: "blocker",
    });
  }
  if (inventory.mergeable === "CONFLICTING") {
    // Hard: won't clear without a rebase.
    blockers.push({
      predicate: "signals.mergeability.state=CONFLICTING",
      fixHint: "resolve merge conflicts before enabling automerge",
      class: "blocker",
    });
  } else if (inventory.mergeable !== "MERGEABLE") {
    // Waiting: null or "UNKNOWN" — GitHub is still computing.
    blockers.push({
      predicate: `signals.mergeability.state=${inventory.mergeable ?? "unknown"}`,
      fixHint: "automerge will queue and fire once GitHub finishes computing mergeability",
      class: "waiting",
    });
  }
  if (inventory.behindBy > 0) {
    // Hard *after* the auto-update-branch retry has already been attempted
    // (or skipped via --no-update-branch). Stale base won't clear without
    // an explicit operator update.
    blockers.push({
      predicate: "sync.remoteFresh=false (behind base)",
      fixHint: "run `gh pr update-branch <n>` (or `prx publisher merge` will retry once for you)",
      class: "blocker",
    });
  }
  pushProvenanceBlocker(blockers, inventory);

  return { ok: hardBlockerCount(blockers) === 0, blockers };
}

/**
 * GH-2249 (I-PROV1): a hard blocker when the merge-guard provenance verdict is
 * "unsigned" — the head commit has a ledger derivation whose SLSA envelope is
 * absent or fails verification under the configured key. Only "unsigned"
 * blocks; absent / "unchecked" (enforcement off or no ledger) / "verified"
 * never do, so the gate is unchanged unless `PRX_REQUIRE_SIGNED_DERIVATIONS`
 * surfaced a real failure. Actor-agnostic — rides the doctor→publisher move
 * (GH-1559) with the rest of the gate.
 */
function pushProvenanceBlocker(
  blockers: DoctorBlocker[],
  inventory: DoctorInventory,
): void {
  if (inventory.provenance === "unsigned") {
    blockers.push({
      predicate: "provenance.signed=unsigned",
      fixHint:
        "the head commit's ledger derivation has no valid signature; re-publish with a configured signer (PRX_PROVENANCE_KEY) so it verifies under PRX_PROVENANCE_PUBKEY",
      class: "blocker",
    });
  }
}

function hardBlockerCount(blockers: DoctorBlocker[]): number {
  return blockers.filter((b) => b.class === "blocker").length;
}

/**
 * GH-1559: shared with `prx publisher` (`./publisher.ts`) — the publication
 * verbs partition the same gate output into hard blockers vs. waiting
 * conditions, so this primitive is exported rather than duplicated.
 */
export function partitionBlockers(blockers: DoctorBlocker[]): {
  hard: DoctorBlocker[];
  waiting: DoctorBlocker[];
} {
  return {
    hard: blockers.filter((b) => b.class === "blocker"),
    waiting: blockers.filter((b) => b.class === "waiting"),
  };
}

export function runInventory(
  target: DoctorTarget,
  format: "plain" | "json",
  output: DoctorOutput,
  deps: DoctorDeps = {},
): number {
  let inventory: DoctorInventory;
  try {
    inventory = loadInventory(target, deps);
  } catch (err) {
    output.error(`prx doctor inventory: ${(err as Error).message}`);
    return 1;
  }

  const reviewGate = reviewGateDisposition(inventory.protection);
  const gates: Record<DoctorVerb, DoctorGateResult> = {
    inventory: { ok: true, blockers: [] },
    ready: gateTransition("ready", inventory),
    merge: gateTransition("merge", inventory),
    draft: gateTransition("draft", inventory),
  };

  if (format === "json") {
    // GH-1354: split merge.blockers into hard `blockers` and transient
    // `waiting`. Other gates only emit hard items; their `waiting` is [].
    const projectedGates = Object.fromEntries(
      (Object.keys(gates) as DoctorVerb[]).map((verb) => {
        const { hard, waiting } = partitionBlockers(gates[verb].blockers);
        return [verb, { ok: gates[verb].ok, blockers: hard, waiting }];
      }),
    ) as Record<DoctorVerb, { ok: boolean; blockers: DoctorBlocker[]; waiting: DoctorBlocker[] }>;
    output.log(
      JSON.stringify(
        {
          target: target.workUnitId,
          inventory,
          gates: {
            ...projectedGates,
            merge: { ...projectedGates.merge, dispositions: { reviewGate } },
          },
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const protectionLine = inventory.protection === null
    ? `(none on ${inventory.baseRefName})`
    : `requires ${inventory.protection.requiredApprovingReviewCount} approval(s), code-owners=${inventory.protection.requireCodeOwnerReviews}`;
  output.log(`prx doctor inventory — ${target.workUnitId} (PR #${inventory.prNumber})`);
  output.log(`  url:               ${inventory.prUrl}`);
  output.log(`  title:             ${inventory.prTitle}`);
  output.log(`  draft:             ${inventory.isDraft}`);
  output.log(`  baseRefName:       ${inventory.baseRefName}`);
  output.log(`  protection:        ${protectionLine}`);
  output.log(`  reviewDecision:    ${inventory.reviewDecision ?? "(none)"}`);
  output.log(`  ci:                ${inventory.ciState}`);
  output.log(`  mergeable:         ${inventory.mergeable ?? "(unknown)"}`);
  output.log(`  mergeStateStatus:  ${inventory.mergeStateStatus ?? "(unknown)"}`);
  output.log(`  unresolvedThreads: ${inventory.unresolvedThreads}`);
  output.log(`  behindBy:          ${inventory.behindBy}`);
  output.log(`  automerge:         ${inventory.autoMergeEnabled ? "enabled" : "disabled"}`);
  if (inventory.autoMergeEnabled) {
    output.log(`    method:          ${inventory.autoMergeMethod ?? "(unknown)"}`);
    output.log(`    enabledBy:       ${inventory.autoMergeEnabledBy ?? "(unknown)"}`);
  }
  output.log("");
  for (const verb of ["ready", "merge", "draft"] as const) {
    const gate = gates[verb];
    const { hard, waiting } = partitionBlockers(gate.blockers);
    let status: string;
    if (hard.length === 0 && waiting.length === 0) {
      status = "ok";
    } else if (hard.length === 0) {
      status = `queued (${waiting.length} waiting)`;
    } else if (waiting.length === 0) {
      status = `blocked (${hard.length})`;
    } else {
      status = `blocked (${hard.length} blockers, ${waiting.length} waiting)`;
    }
    output.log(`  gate ${verb.padEnd(5)} ${status}`);
    for (const blocker of gate.blockers) {
      output.log(`    - ${blocker.predicate}`);
    }
  }
  const reviewGateNote = reviewGate === "skipped"
    ? "skipped (protection requires 0 approvals)"
    : "enforced";
  output.log(`  gate merge.review: ${reviewGateNote}`);
  return 0;
}
