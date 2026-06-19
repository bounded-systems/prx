// GH-983 — `prx delegate next` filter-aware portfolio picker.
//
// Sibling projection over `nextWork()`'s eight-thread output. Where
// `prx next` dumps the full multi-thread surface, `delegate next` returns
// a single top-1 candidate (default) or a filtered list (`--all`) plus a
// suggested operator command. The verb name reflects the operator's
// intent: queueing work for a worktree/session/agent, not manipulating a
// worktree.
//
// State-machine framing: this is a **planning-tier projection**, not a
// state transition. The `prx` actor in `prx model --scope workflow`
// already declares the relevant emits (`NEXT_WORK_PROJECTED`,
// `NEXT_WORK_THREAD_RANKED`) and accepts (`next_work`); the new
// `delegate` actor introduced in this module's registry entry adds no
// new workflow events. Filters apply after `nextWork()` has done the
// bd-canonical join; the bd-ready cache (I-BD2/I-BD3) is reused as-is.
//
// Pure-function design: `selectDelegateCandidate` takes a fully-loaded
// `NextWorkResult` plus an optional enrichment map (labels by bd_id,
// epic→child set) so callers control all bd subprocess access. Tests
// inject fixtures directly.

import { z } from "zod";

import { type NextWorkCandidate, type NextWorkResult, type NextWorkThreadKind } from "./ready.ts";

// Ordering used to break priority ties when ranking across threads.
// Matches `DEFAULT_THREAD_ORDER` in `src/pr-state/next_work.ts` —
// orphan_cleanup first (cheap wins) → intake_queue last. Kept as a local
// constant so this module doesn't import the picker.
const DELEGATE_THREAD_PRECEDENCE: readonly NextWorkThreadKind[] = [
  "orphan_cleanup",
  "pr_awaiting_ci",
  "executor_in_flight",
  "plan_paused",
  "triage_backlog",
  "ready_to_start",
  "blocked",
  "intake_queue",
] as const;

export const DelegateNextFiltersSchema = z
  .object({
    /** Restrict to children of a GH-issue epic (e.g. `GH-974`). */
    epic: z
      .string()
      .regex(/^GH-\d+$/, "epic must be a GH-NNN issue id")
      .optional(),
    /** Restrict to bd rows carrying the `area::<X>` label. */
    area: z.string().min(1).optional(),
    /** Match bd priority numerically (0=critical, 1=high, 2=medium, 3=low). */
    priority: z.number().int().min(0).max(10).optional(),
    /** Match bd issue_type (bug/feature/task/...). */
    type: z.string().min(1).optional(),
    /** When set, return the full filtered list instead of just the top-1. */
    all: z.boolean().default(false),
  })
  .strict();
export type DelegateNextFilters = z.input<typeof DelegateNextFiltersSchema>;
export type ParsedDelegateNextFilters = z.infer<typeof DelegateNextFiltersSchema>;

export const DelegateNextResultSchema = z.object({
  source: z.literal("delegate-next"),
  repo: z.string(),
  /**
   * Filtered candidate list, ordered by (priority asc, thread precedence,
   * bd_id). When `filters.all=false` (the default) this still carries the
   * top-1 candidate (or empty); CLI formatters render just the head.
   */
  candidates: z.array(
    z.object({
      bd_id: z.string(),
      gh_issue: z.number().int().nullable(),
      title: z.string(),
      priority: z.number().int(),
      issue_type: z.string(),
      branch: z.string().nullable(),
      worktree_path: z.string().nullable(),
      status: z.string(),
      thread: z.string(),
      reason: z.string(),
      suggested_command: z.string(),
    }),
  ),
  /** Top-1 reason — surfaced even when `--all` is set. */
  reason: z.string(),
  /** Operator-actionable command for the top-1 candidate, or null if none. */
  suggested_command: z.string().nullable(),
  /** Echo of cache provenance from the underlying `NextWorkResult`. */
  cache: z.object({
    queried_at: z.string(),
    stale: z.boolean(),
    ttl_seconds: z.number().int().positive(),
    refreshed: z.boolean(),
  }),
});
export type DelegateNextResult = z.infer<typeof DelegateNextResultSchema>;

/**
 * Optional enrichment data the CLI handler can supply when filters need
 * facts the bd-ready cache doesn't carry. Pure-function contract: this
 * module performs no bd subprocess calls itself.
 *
 *   - `labelsByBdId`: bd labels per row. Required for `--area`.
 *   - `epicChildBdIds`: bd ids that are transitive children of `filters.epic`.
 *                       Required for `--epic`.
 */
export type DelegateNextEnrichment = {
  labelsByBdId?: ReadonlyMap<string, readonly string[]>;
  epicChildBdIds?: ReadonlySet<string>;
};

function priorityKey(p: number): number {
  return p;
}

function threadIndex(kind: NextWorkThreadKind): number {
  const idx = DELEGATE_THREAD_PRECEDENCE.indexOf(kind);
  return idx === -1 ? DELEGATE_THREAD_PRECEDENCE.length : idx;
}

function suggestedCommandFor(candidate: NextWorkCandidate, threadKind: NextWorkThreadKind): string {
  // If the underlying thread already produced a typed command (e.g.
  // `prx worktree-remove GH-X` for orphan_cleanup, `gh pr ready` for
  // pr_awaiting_ci), preserve it. Otherwise fall back to opening a
  // plan-mode session on the candidate — `delegate` is a planning-tier
  // verb, so `prx plan session` is the canonical handoff for ready work.
  if (candidate.command !== null && candidate.command.length > 0) {
    return candidate.command;
  }
  if (threadKind === "ready_to_start" || threadKind === "blocked") {
    return `prx plan session ${candidate.bd_id}`;
  }
  return `prx plan session ${candidate.bd_id}`;
}

function matchesFilters(
  candidate: NextWorkCandidate,
  filters: ParsedDelegateNextFilters,
  enrichment: DelegateNextEnrichment,
): boolean {
  if (filters.priority !== undefined && candidate.priority !== filters.priority) {
    return false;
  }
  if (filters.type !== undefined && candidate.issue_type !== filters.type) {
    return false;
  }
  if (filters.area !== undefined) {
    const labels = enrichment.labelsByBdId?.get(candidate.bd_id);
    if (!labels || !labels.includes(`area::${filters.area}`)) return false;
  }
  if (filters.epic !== undefined) {
    const children = enrichment.epicChildBdIds;
    if (!children || !children.has(candidate.bd_id)) return false;
  }
  return true;
}

export type SelectDelegateCandidateOptions = {
  filters?: DelegateNextFilters;
  enrichment?: DelegateNextEnrichment;
};

/**
 * Pure projection: flatten `nextWork()` threads → apply filters → rank
 * by (priority asc, thread precedence, bd_id) → return top-1 or full
 * list per `filters.all`. Empty `candidates` array signals "no match"
 * to the CLI handler (exit 1).
 */
export function selectDelegateCandidate(
  result: NextWorkResult,
  opts: SelectDelegateCandidateOptions = {},
): DelegateNextResult {
  const filters = DelegateNextFiltersSchema.parse(opts.filters ?? {});
  const enrichment: DelegateNextEnrichment = opts.enrichment ?? {};

  type Ranked = {
    candidate: NextWorkCandidate;
    thread: NextWorkThreadKind;
  };

  const flattened: Ranked[] = [];
  for (const thread of result.threads) {
    for (const candidate of thread.candidates) {
      if (!matchesFilters(candidate, filters, enrichment)) continue;
      flattened.push({ candidate, thread: thread.kind });
    }
  }

  flattened.sort((a, b) => {
    const byPrio = priorityKey(a.candidate.priority) - priorityKey(b.candidate.priority);
    if (byPrio !== 0) return byPrio;
    const byThread = threadIndex(a.thread) - threadIndex(b.thread);
    if (byThread !== 0) return byThread;
    return a.candidate.bd_id.localeCompare(b.candidate.bd_id);
  });

  const kept = filters.all ? flattened : flattened.slice(0, 1);

  const candidates = kept.map((r) => ({
    bd_id: r.candidate.bd_id,
    gh_issue: r.candidate.gh_issue,
    title: r.candidate.title,
    priority: r.candidate.priority,
    issue_type: r.candidate.issue_type,
    branch: r.candidate.branch,
    worktree_path: r.candidate.worktree_path,
    status: r.candidate.status,
    thread: r.thread,
    reason: r.candidate.reason,
    suggested_command: suggestedCommandFor(r.candidate, r.thread),
  }));

  const head = candidates[0];
  const reason = head !== undefined ? head.reason : "no candidates matched the supplied filters";
  const suggestedCommand = head?.suggested_command ?? null;

  return {
    source: "delegate-next",
    repo: result.repo,
    candidates,
    reason,
    suggested_command: suggestedCommand,
    cache: {
      queried_at: result.cache.queried_at,
      stale: result.cache.stale,
      ttl_seconds: result.cache.ttl_seconds,
      refreshed: result.cache.refreshed,
    },
  };
}

/**
 * Human-readable formatter for the top-1 default surface. CLI handler
 * uses this for non-JSON output. `--all` callers iterate `candidates`
 * via a list formatter (see `formatDelegateNextList`).
 */
export function formatDelegateNext(result: DelegateNextResult): string {
  if (result.candidates.length === 0) {
    return `delegate next: ${result.reason}`;
  }
  const top = result.candidates[0]!;
  const ghSuffix = top.gh_issue !== null ? ` (GH-${top.gh_issue})` : "";
  const lines = [
    `delegate next → ${top.bd_id}${ghSuffix}: ${top.title}`,
    `  thread:   ${top.thread}`,
    `  priority: ${top.priority}`,
    `  reason:   ${top.reason}`,
    `  next:     ${top.suggested_command}`,
  ];
  return lines.join("\n");
}

export function formatDelegateNextList(result: DelegateNextResult): string {
  if (result.candidates.length === 0) {
    return `delegate next: ${result.reason}`;
  }
  const lines: string[] = [
    `delegate next (${result.candidates.length} candidate${result.candidates.length === 1 ? "" : "s"}):`,
  ];
  for (const c of result.candidates) {
    const ghSuffix = c.gh_issue !== null ? ` (GH-${c.gh_issue})` : "";
    lines.push(`  [${c.thread}] p${c.priority} ${c.bd_id}${ghSuffix} — ${c.title}`);
    lines.push(`      → ${c.suggested_command}`);
  }
  return lines.join("\n");
}
