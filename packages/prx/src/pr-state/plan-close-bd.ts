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
} from "@bounded-systems/bd";
import {
  loadAllBeads as defaultLoadAllBeads,
  type BeadsRecord,
} from "../triage/triage.ts";
import { buildBeadsLookup } from "../issues/dedupe.ts";

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
