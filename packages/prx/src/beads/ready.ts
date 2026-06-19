// GH-1510: bd-ready + dep-graph read surface for the next-work picker.
//
// This module is the **typed read path** for the bd-canonical work-graph.
// Source-of-truth shape lives in the Zod schemas below; everything else
// (cache layer in `ready_cache.ts`, picker in `src/pr-state/next_work.ts`,
// projection writer in `src/projection/gh_project.ts`) parses through these
// schemas at the bd↔prx boundary.
//
// Schemas (per GH-1510 Phase A):
//   - BdReadyCandidateSchema  — one bd record surfaced as ready or blocked.
//   - BdDepEdgeSchema         — typed dependency edge (kind ∈ blocks /
//                               parent-child / relates_to / duplicates /
//                               supersedes / replies_to).
//   - BdReadyCacheSchema      — atomic on-disk cache envelope (I-BD2/3).
//   - NextWorkThreadSchema    — one operator-visible parallel thread.
//   - NextWorkResultSchema    — the picker's portfolio output.

import { z } from "zod";
import { execBd, type BdExecOptions } from "@bounded-systems/bd";

// bd issue type strings observed in `bd ready --json` (`issue_type` field).
// Kept as an open string so a new bd type doesn't break parsing — the picker
// doesn't switch on type today; this just preserves provenance.
const BdIssueType = z.string().min(1);

// bd priority is numeric (0=critical, 1=high, 2=medium, 3=low). Pass the raw
// integer through — the picker sorts on it directly. Open range so a future
// bd schema extension can't break callers.
const BdPriority = z.number().int().min(0).max(10);

// bd status strings used in this codebase. `bd ready` only ever emits open;
// `bd ready --explain` surfaces blocked siblings whose status is open + has
// open blockers; closed/in_progress show up via `bd list`. Open enum for
// forward compatibility.
const BdStatus = z.enum(["open", "in_progress", "blocked", "deferred", "closed"]);

export type BdStatus = z.infer<typeof BdStatus>;

// Typed dependency edge as bd emits it from `bd dep list <id> --json`. The
// `dependency_type` column on each related row carries the edge kind. bd
// presently emits: blocks, parent-child, relates_to, duplicates, supersedes,
// replies_to. Unknown kinds passthrough as the raw string.
const BdDepKind = z.union([
  z.enum(["blocks", "parent-child", "relates_to", "duplicates", "supersedes", "replies_to"]),
  z.string().min(1),
]);

export type BdDepKind = z.infer<typeof BdDepKind>;

export const BdDepEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: BdDepKind,
});
export type BdDepEdge = z.infer<typeof BdDepEdgeSchema>;

// One blocker as emitted inline in `bd ready --explain --json` under
// `blocked[].blocked_by[]`. Stripped to the fields the picker actually needs
// (id + status — to gate the I-BD1 check "blocked_by ∩ open != ∅"). Title
// preserved for operator-facing messages.
const BdBlockerRefSchema = z
  .object({
    id: z.string().min(1),
    status: BdStatus,
    title: z.string().optional(),
    priority: BdPriority.optional(),
  })
  .passthrough();

export const BdReadyCandidateSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    status: BdStatus,
    priority: BdPriority,
    issue_type: BdIssueType,
    created_at: z.string(),
    updated_at: z.string(),
    // GH→bd mirror link. Set when bd has been GitHub-promoted; null for
    // beads-only items. The numeric GH issue number is extracted by the
    // picker from this URL via the existing helper.
    external_ref: z.string().nullable().optional(),
    source_system: z.string().nullable().optional(),
    labels: z.array(z.string()).default([]),
    // Inline blocking edges from `bd ready --explain --json` blocked[]. Empty
    // for items in the `ready` bucket (no blockers by definition).
    blocked_by: z.array(BdBlockerRefSchema).default([]),
    blocked_by_count: z.number().int().nonnegative().default(0),
    // `bd ready --explain` surfaces these on ready rows for the human-facing
    // "why is this ready" reason. Preserved verbatim.
    reason: z.string().optional(),
    resolved_blockers: z.array(z.unknown()).nullable().optional(),
  })
  .passthrough();
export type BdReadyCandidate = z.infer<typeof BdReadyCandidateSchema>;

// The full `bd ready --explain --json` envelope. The legacy form (`bd ready
// --json` without `--explain`) returns a raw array; the picker calls
// `--explain` so it gets both buckets in one shot — no second round-trip.
export const BdReadyExplainEnvelopeSchema = z.object({
  ready: z.array(BdReadyCandidateSchema).default([]),
  blocked: z.array(BdReadyCandidateSchema).default([]),
});
export type BdReadyExplainEnvelope = z.infer<typeof BdReadyExplainEnvelopeSchema>;

// On-disk cache envelope. Written atomically (tmp + rename) by
// `ready_cache.ts` to satisfy I-BD2. `queried_at + ttl_seconds` is the
// staleness gate from I-BD3.
export const BdReadyCacheSchema = z.object({
  run_id: z.string().min(1),
  queried_at: z.string().datetime({ offset: true }),
  ttl_seconds: z.number().int().positive(),
  ready: z.array(BdReadyCandidateSchema),
  blocked: z.array(BdReadyCandidateSchema),
  edges: z.array(BdDepEdgeSchema),
});
export type BdReadyCache = z.infer<typeof BdReadyCacheSchema>;

// One operator-visible parallel thread on the next-work surface.
//
// `kind` enumerates the parallel work classes the operator sees today
// (executor in flight, plan paused, etc.). The picker assigns each joined
// row to exactly one kind; the cross-thread ordering is configurable via
// `prx.toml [next_work] thread_order`.
const NextWorkThreadKind = z.enum([
  "orphan_cleanup",
  "pr_awaiting_ci",
  "executor_in_flight",
  "plan_paused",
  "triage_backlog",
  "ready_to_start",
  "blocked",
  "intake_queue",
]);
export type NextWorkThreadKind = z.infer<typeof NextWorkThreadKind>;

// One candidate row inside a thread. Carries enough context for the
// status-line surface ("Start GH-1510" / "Open PR for GH-1234") without
// re-reading bd or GH.
export const NextWorkCandidateSchema = z.object({
  bd_id: z.string().min(1),
  gh_issue: z.number().int().nullable(),
  title: z.string(),
  priority: BdPriority,
  issue_type: BdIssueType,
  branch: z.string().nullable(),
  worktree_path: z.string().nullable(),
  status: BdStatus,
  blocked_by: z.array(z.string().min(1)).default([]),
  reason: z.string(),
  command: z.string().nullable(),
});
export type NextWorkCandidate = z.infer<typeof NextWorkCandidateSchema>;

export const NextWorkThreadSchema = z.object({
  kind: NextWorkThreadKind,
  candidates: z.array(NextWorkCandidateSchema),
  recommended_action: z.string(),
  cost_of_context_switch: z.enum(["low", "medium", "high"]),
  reason: z.string(),
});
export type NextWorkThread = z.infer<typeof NextWorkThreadSchema>;

export const NextWorkResultSchema = z.object({
  source: z.literal("next-work"),
  repo: z.string(),
  threads: z.array(NextWorkThreadSchema),
  cache: z.object({
    queried_at: z.string().datetime({ offset: true }),
    stale: z.boolean(),
    ttl_seconds: z.number().int().positive(),
    refreshed: z.boolean(),
  }),
});
export type NextWorkResult = z.infer<typeof NextWorkResultSchema>;

// ---------------------------------------------------------------------------
// Query layer
// ---------------------------------------------------------------------------

// A runner of `bd` subcommands. Mirrors the `BdGithubRunner` injection
// pattern in `src/tools/bd.ts` so tests don't need a real `bd` binary.
export type BdRunner = (opts: BdExecOptions) => {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export const defaultBdRunner: BdRunner = (opts) => {
  const result = execBd(opts);
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
};

export type QueryBdReadyOptions = {
  cwd: string;
  runner?: BdRunner | undefined;
};

export type QueryBdReadyResult = {
  ready: BdReadyCandidate[];
  blocked: BdReadyCandidate[];
  raw: string;
};

/**
 * Read `bd ready --explain --json` into typed records. Uses `--explain` so we
 * get both ready and blocked buckets (with inline `blocked_by` edges) in one
 * round-trip — avoids a second `bd dep list` per item for the I-BD1 gate.
 *
 * Returns empty buckets when bd has no ready work AND no blocked items; this
 * is distinct from a bd failure, which throws.
 */
export function queryBdReady(opts: QueryBdReadyOptions): QueryBdReadyResult {
  const runner = opts.runner ?? defaultBdRunner;
  const result = runner({
    subcommand: "ready",
    args: ["--explain", "--json"],
    cwd: opts.cwd,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `bd ready --explain --json failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }

  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) {
    return { ready: [], blocked: [], raw: result.stdout };
  }

  const parsed: unknown = JSON.parse(trimmed);

  // bd has two output shapes:
  //   - `bd ready --json`            → array of ready records (legacy)
  //   - `bd ready --explain --json`  → { ready: [], blocked: [] }
  // Accept both so callers/tests can hand either shape.
  if (Array.isArray(parsed)) {
    const ready = parsed.map((r) => BdReadyCandidateSchema.parse(r));
    return { ready, blocked: [], raw: result.stdout };
  }

  const envelope = BdReadyExplainEnvelopeSchema.parse(parsed);
  return { ready: envelope.ready, blocked: envelope.blocked, raw: result.stdout };
}

export type QueryBdGraphOptions = {
  cwd: string;
  runner?: BdRunner;
  /** Issue IDs to enumerate edges for. One `bd dep list <id> --json` per id. */
  ids: string[];
};

/**
 * Read typed dep edges for a set of bd IDs via `bd dep list <id> --json`.
 *
 * One round-trip per id — bd's `dep list` is per-issue. For the picker we
 * usually don't need this (`bd ready --explain --json` already carries the
 * blocked_by edges inline); this query exists for the projection writer and
 * future graph-shape consumers.
 *
 * Edges are normalized to a uniform `BdDepEdge` shape with `from` = the
 * queried id and `to` = the related id; `kind` is the bd-emitted
 * `dependency_type`.
 */
export function queryBdGraph(opts: QueryBdGraphOptions): BdDepEdge[] {
  const runner = opts.runner ?? defaultBdRunner;
  const edges: BdDepEdge[] = [];

  for (const id of opts.ids) {
    const result = runner({
      subcommand: "dep",
      args: ["list", id, "--json"],
      cwd: opts.cwd,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `bd dep list ${id} --json failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    const trimmed = result.stdout.trim();
    if (trimmed.length === 0) continue;
    const rows: unknown = JSON.parse(trimmed);
    if (!Array.isArray(rows)) {
      throw new Error(`bd dep list ${id} --json did not return an array`);
    }
    for (const row of rows) {
      const parsed = z
        .object({
          id: z.string().min(1),
          dependency_type: BdDepKind,
        })
        .passthrough()
        .parse(row);
      edges.push({ from: id, to: parsed.id, kind: parsed.dependency_type });
    }
  }

  return edges;
}

/**
 * I-BD1 filter — return only candidates whose blockers are all closed (i.e.,
 * `blocked_by ∩ openIds == ∅`). `openIds` is "every bd id whose status is
 * not closed"; passing in the set lets the picker source it from one bd
 * query rather than per-candidate.
 *
 * Pure: no I/O, fully testable. The candidate's own status is **not** part
 * of the filter — callers (the picker) gate on `status === "open"` before
 * calling this so blocked/in_progress items don't surface as ready.
 */
export function filterBlocked(
  candidates: BdReadyCandidate[],
  edges: BdDepEdge[],
  openIds: Set<string>,
): BdReadyCandidate[] {
  // Build a per-id "blockers" map from edges (kind=blocks where `to` blocks
  // `from`). The inline `blocked_by` on a candidate is the primary source
  // (set by bd --explain); edges supplement when caller passed them in.
  const blockersByCandidate = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== "blocks") continue;
    const blockers = blockersByCandidate.get(edge.from) ?? new Set<string>();
    blockers.add(edge.to);
    blockersByCandidate.set(edge.from, blockers);
  }

  return candidates.filter((candidate) => {
    const inline = candidate.blocked_by.map((b) => b.id);
    const extra = blockersByCandidate.get(candidate.id);
    const all = new Set<string>(inline);
    if (extra) {
      for (const id of extra) all.add(id);
    }
    for (const blockerId of all) {
      if (openIds.has(blockerId)) return false;
    }
    return true;
  });
}
