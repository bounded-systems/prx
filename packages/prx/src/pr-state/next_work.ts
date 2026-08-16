// GH-1510 — bd-canonical multi-thread next-work picker.
//
// This module replaces the single-pick `nextWorktree()` ranker
// (`src/pr-state/github.ts:5772-5819`). The source of truth is the bd
// work-graph (`bd ready --explain --json`), joined with the local
// parity-chain view (`boardStatus()`). Output: a `NextWorkResult`
// validated through `NextWorkResultSchema` — a ranked set of parallel
// threads (executor in flight, plan paused, triage backlog, etc.), not a
// single suggestion. The status-line surface reads
// `result.threads[0].recommended_action` for the top headline.
//
// Boundary contracts:
//   - I-BD1: a unit only enters the `ready_to_start` thread when
//            `bd.status='open' && bd.blocked_by ∩ openIds == ∅`.
//   - I-BD3: when the cache was older than TTL on read the result's
//            `cache.stale=true` so downstream surfaces (audit log,
//            status-line) can emit BD_READY_CACHE_STALE_SERVED.
//   - GH-1500 §3a: this layer is **read** — it does not push bd state to
//                  any GH mirror. `runBdGithubSyncPullOnly()` remains the
//                  canonical write-back path (see `src/tools/bd.ts:238`).
//                  The Phase D projection writer (`src/projection/
//                  gh_project.ts`) targets GH-Projects, not GH-Issues.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AuditSinkDeps } from "../audit/sink.ts";
import {
  NextWorkResultSchema,
  type BdReadyCandidate,
  type NextWorkCandidate,
  type NextWorkResult,
  type NextWorkThread,
  type NextWorkThreadKind,
} from "../beads/ready.ts";
import { getBdReady, loadReadyTtlSeconds, type GetBdReadyResult } from "../beads/ready_cache.ts";
import { recordEvent } from "../machine/record_event.ts";
import {
  applyAuthorityOverrides,
  boardStatus,
  defaultRunner,
  type BoardColumn,
  type BoardStatusResult,
  type BoardUnit,
  type CommandRunner,
} from "./github.ts";
import { readTransitionLog, type TransitionEntry } from "./transition_log.ts";
import { runStatusActor, type TriageStatusResult } from "../triage/triage.ts";

export const DEFAULT_THREAD_ORDER: readonly NextWorkThreadKind[] = [
  "orphan_cleanup",
  "pr_awaiting_ci",
  "executor_in_flight",
  "plan_paused",
  "triage_backlog",
  "ready_to_start",
  "blocked",
  "intake_queue",
] as const;

const EXECUTOR_IN_FLIGHT_COLUMNS: ReadonlySet<BoardColumn> = new Set<BoardColumn>([
  "committing",
  "pushed",
  "pr_open",
  "review",
  "changes_requested",
  "approved",
  "merge_ready",
]);

export type NextWorkOptions = {
  runner?: CommandRunner;
  /** TTL override (otherwise loaded from prx.toml or 60s default). */
  ttlSeconds?: number;
  /** Bypass the cache and re-query bd live. */
  force?: boolean;
  /** Override the thread ordering (otherwise from prx.toml). */
  threadOrder?: readonly NextWorkThreadKind[];
  /** Test injection: provide the bd-ready cache directly. */
  bdReady?: GetBdReadyResult;
  /** Test injection: provide a pre-computed parity-chain board. */
  board?: BoardStatusResult;
  /** Audit-sink DI seam for catalog-event emissions (GH-1616). */
  auditDeps?: AuditSinkDeps;
  /**
   * GH-1617: test injection for the `triage_backlog` thread. When provided,
   * the picker skips the live `runStatusActor()` call and projects this
   * snapshot directly. Mirrors `opts.bdReady` and `opts.board`.
   */
  triage?: TriageStatusResult;
  /**
   * GH-1617: test injection for the `plan_paused` thread. When provided, the
   * picker skips reading `.prx/transitions.jsonl` and uses these entries
   * directly. Empty array → no paused plans (the picker treats a missing log
   * the same way).
   */
  transitionLog?: TransitionEntry[];
  /**
   * GH-1617: TTL override for the plan-paused predicate (otherwise loaded
   * from `prx.toml [next_work] plan_paused_ttl_seconds` with a 24h default).
   */
  plannedPausedTtlSeconds?: number;
  /** GH-1617: clock injection for the I-NW2 staleness check. */
  now?: Date;
};

// GH-1617: planning-role actors per the workflow actor catalog. A transition
// log entry whose `actor` is one of these is a planning-tier marker for the
// I-NW2 predicate. "agent.planner" is the EXTRA_KNOWN_ACTORS alias the cli
// transition log validator accepts; both shapes have appeared in the wild.
const PLANNER_ROLE_ACTORS: ReadonlySet<string> = new Set(["planner_agent", "agent.planner"]);

// GH-1617: executor-role actors. A later entry with one of these `actor`
// values short-circuits the paused-plan predicate — the unit is past
// planning and lives in the executor surface.
const EXECUTOR_ROLE_ACTORS: ReadonlySet<string> = new Set(["executor_agent", "agent.executor"]);

const DEFAULT_PLAN_PAUSED_TTL_SECONDS = 24 * 60 * 60;

const TRANSITION_LOG_REL_PATH = ".prx/transitions.jsonl";

function extractGhIssueNumber(externalRef: string | null | undefined): number | null {
  if (!externalRef) return null;
  const match = externalRef.match(/\/issues\/(\d+)(?:[/?#]|$)/);
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

function priorityKey(p: number): number {
  // bd priorities are lower-is-higher (0=critical → 3=low). Sort ascending.
  return p;
}

function sortCandidates(rows: NextWorkCandidate[]): NextWorkCandidate[] {
  return rows.sort((a, b) => {
    const byPrio = priorityKey(a.priority) - priorityKey(b.priority);
    if (byPrio !== 0) return byPrio;
    return a.bd_id.localeCompare(b.bd_id);
  });
}

function ticketIdToBdId(ticket: string | null, bd: BdReadyCandidate): boolean {
  if (!ticket) return false;
  const ghIssue = extractGhIssueNumber(bd.external_ref);
  if (ghIssue === null) return false;
  const ticketGh = ticket.match(/^GH-(\d+)$/i);
  return ticketGh !== null && Number.parseInt(ticketGh[1]!, 10) === ghIssue;
}

function makeCandidate(
  bd: BdReadyCandidate,
  unit: BoardUnit | null,
  reason: string,
  command: string | null,
): NextWorkCandidate {
  return {
    bd_id: bd.id,
    gh_issue: extractGhIssueNumber(bd.external_ref),
    title: bd.title,
    priority: bd.priority,
    issue_type: bd.issue_type,
    branch: unit?.branch ?? null,
    worktree_path: unit?.worktree_path ?? null,
    status: bd.status,
    blocked_by: bd.blocked_by.map((b) => b.id),
    reason,
    command,
  };
}

function recommendForColumn(unit: BoardUnit): string {
  const ticket = unit.ticket ?? unit.branch;
  switch (unit.column) {
    case "cleanup_pending":
      return `prx worktree-remove ${ticket} --delete-branch`;
    case "committing":
      return "git add -A && git commit -m '<message>'";
    case "pushed":
      return "gh pr create --draft";
    case "pr_open":
      return "gh pr ready";
    case "ci_running":
      return "gh pr checks --watch";
    case "review":
      return "prx event --skill pr-ready";
    case "changes_requested":
      return "prx event --skill pr-fix";
    case "approved":
    case "merge_ready":
      return "gh pr merge --squash --delete-branch";
    case "no_worktree":
    case "worktree_created":
    case "branch_created":
      return `prx plan session ${ticket}`;
    case "merged":
    case "cleaned":
      return `prx plan session ${ticket}`;
  }
}

function threadHeadline(
  kind: NextWorkThreadKind,
  count: number,
): { recommended: string; reason: string; cost: NextWorkThread["cost_of_context_switch"] } {
  switch (kind) {
    case "orphan_cleanup":
      return {
        recommended: count > 0 ? "Clean up orphaned worktrees" : "No orphans",
        reason: "Issue closed or PR merged but artifacts remain",
        cost: "low",
      };
    case "pr_awaiting_ci":
      return {
        recommended: count > 0 ? "Watch CI on the open PR" : "No PRs awaiting CI",
        reason: "Branch pushed, CI in flight",
        cost: "low",
      };
    case "executor_in_flight":
      return {
        recommended: count > 0 ? "Advance the in-flight PR" : "No PRs in flight",
        reason: "Local + remote artifacts present; pick up from current column",
        cost: "medium",
      };
    case "plan_paused":
      return {
        recommended: count > 0 ? "Resume a paused plan" : "No paused plans",
        reason: "Plan contract present but no recent activity",
        cost: "medium",
      };
    case "triage_backlog":
      return {
        recommended: count > 0 ? "Run triage prime" : "Triage backlog empty",
        reason: "Untriaged or drifting bd rows",
        cost: "low",
      };
    case "ready_to_start":
      return {
        recommended: count > 0 ? "Open a session on the top ready bead" : "No ready work",
        reason: "bd-ready with no blockers and no worktree yet",
        cost: "high",
      };
    case "blocked":
      return {
        recommended: count > 0 ? "Unblock the highest-priority blocked bead" : "Nothing blocked",
        reason: "Has at least one open blocker",
        cost: "medium",
      };
    case "intake_queue":
      return {
        recommended: count > 0 ? "Run prx intake on unparented work" : "No intake backpressure",
        reason: "Worktrees / branches with no bd record",
        cost: "low",
      };
  }
}

function emptyThread(kind: NextWorkThreadKind): NextWorkThread {
  const head = threadHeadline(kind, 0);
  return {
    kind,
    candidates: [],
    recommended_action: head.recommended,
    cost_of_context_switch: head.cost,
    reason: head.reason,
  };
}

// GH-1617: parse `prx.toml [next_work] plan_paused_ttl_seconds`. Mirrors
// `loadThreadOrder` — single file read, no TOML library dependency.
function loadPausedPlanTtl(repoPath: string): number {
  const configPath = join(repoPath, "prx.toml");
  if (!existsSync(configPath)) return DEFAULT_PLAN_PAUSED_TTL_SECONDS;
  let section = "";
  for (const rawLine of readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      continue;
    }
    if (section !== "next_work") continue;
    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyMatch || keyMatch[1] !== "plan_paused_ttl_seconds") continue;
    const raw = (keyMatch[2] ?? "").trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_PLAN_PAUSED_TTL_SECONDS;
}

// GH-1617 (I-NW2): identify issues whose most-recent transition-log entry is
// a planning-role marker older than `staleSeconds`, with no later
// executor-role or planner-completion entry. Pure predicate so tests can
// inject entries directly.
//
// Predicate per I-NW2:
//   1. Group entries by `issue` (skip null `issue`).
//   2. Per group, the most-recent entry wins. If its actor is a planner
//      variant AND its timestamp is older than `staleSeconds`, the unit is
//      paused. A later executor entry can't exist (by "most recent"); a
//      later planner-completion (`actor=planner_agent` writing a non-
//      planning state) is also subsumed.
export function derivePausedPlans(
  entries: readonly TransitionEntry[],
  now: Date,
  staleSeconds: number,
): Map<string, TransitionEntry> {
  const newestByIssue = new Map<string, TransitionEntry>();
  for (const entry of entries) {
    if (entry.issue === null) continue;
    const prior = newestByIssue.get(entry.issue);
    if (!prior || entry.timestamp > prior.timestamp) {
      newestByIssue.set(entry.issue, entry);
    }
  }

  const paused = new Map<string, TransitionEntry>();
  const cutoffMs = now.getTime() - staleSeconds * 1000;
  for (const [issue, entry] of newestByIssue.entries()) {
    if (!PLANNER_ROLE_ACTORS.has(entry.actor)) continue;
    if (EXECUTOR_ROLE_ACTORS.has(entry.actor)) continue;
    const ts = Date.parse(entry.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (ts > cutoffMs) continue;
    paused.set(issue, entry);
  }
  return paused;
}

// GH-1617: load transition entries from the canonical repo-relative path
// (`.prx/transitions.jsonl`). Missing file → empty array (parity with
// `readTransitionLog`'s existsSync guard).
function loadTransitionLogForRepo(repoPath: string): TransitionEntry[] {
  try {
    return readTransitionLog(join(repoPath, TRANSITION_LOG_REL_PATH));
  } catch {
    // Malformed log lines should not take the picker down — degrade to "no
    // paused-plan signal" rather than throwing past the boundary.
    return [];
  }
}

// GH-1617: pull the triage snapshot via `runStatusActor()`. Triage requires a
// working `bd` substrate + `gh` auth, so a missing/broken environment
// degrades to "no triage signal" rather than failing the picker. The spawn is
// gated on the path being an actual GIT WORKING TREE (`.git` present, as a dir
// in the main repo or a file in a worktree): triage reads git + bd, so a path
// with no `.git` can yield nothing anyway. Gating on `.git` ALONE (not "`.git`
// OR `prx.toml`") is also what keeps fixture-driven tests hermetic — a temp dir
// holding only a `prx.toml` (e.g. the config-reader tests) must short-circuit
// here, else `runStatusActor` spawns `bd`/`gh` and HANGS with no daemon/auth.
function loadTriageSnapshot(repoPath: string): TriageStatusResult | null {
  if (!existsSync(join(repoPath, ".git"))) {
    return null;
  }
  try {
    const result = runStatusActor(
      {
        repo: undefined,
        format: "json",
        limit: 0,
        includeIntentional: false,
        rateLimit: false,
        // GH-1786 — the next-work picker reads the triage snapshot
        // opportunistically; opt out of the read-time refresh so a missing/
        // broken external auth context can never block candidate selection.
        maxStaleness: "24h",
        noRefresh: true,
      },
      { cwd: () => repoPath },
    );
    return result.snapshot;
  } catch {
    return null;
  }
}

// GH-1617: suppression keys for I-NW3. We record both the bd_id and a
// `GH-<n>` ticket string so a paused-plan entry keyed on the GH branch can
// match a candidate that landed in another bucket via its bd id.
function suppressionKeysForCandidate(candidate: NextWorkCandidate): string[] {
  const keys = [candidate.bd_id];
  if (candidate.gh_issue !== null) keys.push(`GH-${candidate.gh_issue}`);
  if (candidate.branch !== null) keys.push(candidate.branch);
  return keys;
}

// GH-1617 (I-NW1 projector): map triage rows into NextWorkCandidate shape and
// push them into the `triage_backlog` bucket. Direction-locked read — never
// writes to triage. I-NW3 suppression is applied via `suppressedKeys`.
function projectTriageBacklog(
  snapshot: TriageStatusResult,
  buckets: Map<NextWorkThreadKind, NextWorkCandidate[]>,
  suppressedKeys: ReadonlySet<string>,
): void {
  const out: NextWorkCandidate[] = [];

  for (const row of snapshot.issues) {
    const bdId = row.beadsId ?? `GH-${row.number}`;
    if (suppressedKeys.has(bdId)) continue;
    if (suppressedKeys.has(`GH-${row.number}`)) continue;
    out.push({
      bd_id: bdId,
      gh_issue: row.number,
      title: row.title,
      priority: 3,
      issue_type: "unknown",
      branch: null,
      worktree_path: null,
      status: "open",
      blocked_by: [],
      reason: `Untriaged: missing ${row.missing.join("/")}`,
      command: `prx triage promote GH-${row.number}`,
    });
  }

  // GH-1710 / prx-3f1: reverse-orphans (bd records with no external_ref) are the
  // NORMAL beads-first state, not a remediation orphan. They are informational
  // only — we deliberately do NOT project them into triage_backlog candidates,
  // so `prx next-work` never emits `prx beads publish <id>` for a bead whose only
  // "issue" is a missing GH mirror. This supersedes the GH-2011 'GitHub canonical'
  // framing. The reverseOrphans snapshot field is retained for visibility.

  for (const row of snapshot.drift) {
    if (suppressedKeys.has(row.beadsId)) continue;
    if (suppressedKeys.has(`GH-${row.issueNumber}`)) continue;
    out.push({
      bd_id: row.beadsId,
      gh_issue: row.issueNumber,
      title: row.beadsId,
      priority: 3,
      issue_type: "unknown",
      branch: null,
      worktree_path: null,
      status: "open",
      blocked_by: [],
      reason: `Drift: ${Object.keys(row.fields).join("/")}`,
      command: "prx triage apply",
    });
  }

  for (const row of snapshot.stale) {
    if (suppressedKeys.has(row.beadsId)) continue;
    if (suppressedKeys.has(`GH-${row.issueNumber}`)) continue;
    out.push({
      bd_id: row.beadsId,
      gh_issue: row.issueNumber,
      title: row.title,
      priority: priorityLabelToNumber(row.priority),
      issue_type: row.issueType || "unknown",
      branch: null,
      worktree_path: null,
      status: "open",
      blocked_by: [],
      reason: "Stale — linked GH issue closed",
      command: `bd update ${row.beadsId} --status closed`,
    });
  }

  if (out.length === 0) return;
  const existing = buckets.get("triage_backlog") ?? [];
  buckets.set("triage_backlog", [...existing, ...out]);
}

// GH-1617 (I-NW2 projector): emit one candidate per paused-plan issue. Joins
// against the bd-ready/blocked cache when available so priority/title carry
// through; falls back to a synthetic priority-2 row otherwise. I-NW3
// suppression filters out units that already landed in higher-precedence
// buckets.
function projectPlanPaused(
  paused: Map<string, TransitionEntry>,
  bdCandidates: readonly BdReadyCandidate[],
  buckets: Map<NextWorkThreadKind, NextWorkCandidate[]>,
  suppressedKeys: ReadonlySet<string>,
): void {
  const out: NextWorkCandidate[] = [];

  // Build a lookup by GH-N ticket so we can pull bd metadata when the
  // transition log's `issue` field is a GH branch (the cli writes
  // `detectBranchNameFromCwd()` into that slot — typically "GH-<n>").
  const bdByTicket = new Map<string, BdReadyCandidate>();
  for (const bd of bdCandidates) {
    const gh = extractGhIssueNumber(bd.external_ref);
    if (gh !== null) bdByTicket.set(`GH-${gh}`, bd);
    bdByTicket.set(bd.id, bd);
  }

  for (const [issue, entry] of paused.entries()) {
    if (suppressedKeys.has(issue)) continue;
    const bd = bdByTicket.get(issue);
    if (bd && suppressedKeys.has(bd.id)) continue;

    const gh = bd ? extractGhIssueNumber(bd.external_ref) : extractGhIssueFromTicket(issue);
    const command = gh !== null ? `prx plan session GH-${gh}` : `prx plan session ${issue}`;

    out.push({
      bd_id: bd?.id ?? issue,
      gh_issue: gh,
      title: bd?.title ?? issue,
      priority: bd?.priority ?? 2,
      issue_type: bd?.issue_type ?? "unknown",
      branch: typeof entry.issue === "string" ? entry.issue : null,
      worktree_path: null,
      status: "open",
      blocked_by: bd?.blocked_by.map((b) => b.id) ?? [],
      reason: `Plan paused since ${entry.timestamp}`,
      command,
    });
  }

  if (out.length === 0) return;
  const existing = buckets.get("plan_paused") ?? [];
  buckets.set("plan_paused", [...existing, ...out]);
}

// Helper: parse `GH-<n>` shaped tickets into a numeric GH issue number. The
// transition log's `issue` field is the branch name, which is conventionally
// `GH-<n>` for work-unit branches.
function extractGhIssueFromTicket(ticket: string): number | null {
  const match = ticket.match(/^GH-(\d+)$/);
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

// Helper: invert `bdPriorityToLabel` (defined in src/triage/triage.ts) — the
// triage `priority` slots arrive as label strings, but `NextWorkCandidate`
// carries the numeric bd priority. Unknown → 3 (low) so an unscored row
// sinks to the bottom rather than masquerading as critical.
function priorityLabelToNumber(label: string): number {
  switch (label) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 3;
  }
}

function loadThreadOrder(repoPath: string): NextWorkThreadKind[] {
  const configPath = join(repoPath, "prx.toml");
  if (!existsSync(configPath)) return [...DEFAULT_THREAD_ORDER];
  let section = "";
  for (const rawLine of readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      continue;
    }
    if (section !== "next_work") continue;
    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyMatch || keyMatch[1] !== "thread_order") continue;
    const raw = (keyMatch[2] ?? "").trim();
    // Accept TOML array literal: thread_order = ["a", "b", ...]
    if (!raw.startsWith("[") || !raw.endsWith("]")) continue;
    const inner = raw.slice(1, -1);
    const ids = inner
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter((s) => s.length > 0);
    const validKinds = new Set<NextWorkThreadKind>(DEFAULT_THREAD_ORDER);
    const ordered: NextWorkThreadKind[] = [];
    for (const id of ids) {
      if (validKinds.has(id as NextWorkThreadKind) && !ordered.includes(id as NextWorkThreadKind)) {
        ordered.push(id as NextWorkThreadKind);
      }
    }
    // Append any default kinds not listed so the result is exhaustive.
    for (const kind of DEFAULT_THREAD_ORDER) {
      if (!ordered.includes(kind)) ordered.push(kind);
    }
    return ordered;
  }
  return [...DEFAULT_THREAD_ORDER];
}

/**
 * Compute the multi-thread next-work surface for a repo.
 *
 * Joins bd-ready candidates (sync-if-stale cached, GH-1510 Phase B) with the
 * parity-chain board (`boardStatus()` + `applyAuthorityOverrides()`). Classifies
 * each joined row into one `NextWorkThread` kind and returns the threads in
 * the configured order. Output is Zod-validated against
 * `NextWorkResultSchema`.
 */
export function nextWork(repoPath: string, opts: NextWorkOptions = {}): NextWorkResult {
  const runner = opts.runner ?? defaultRunner;
  const ttlSeconds = opts.ttlSeconds ?? loadReadyTtlSeconds(repoPath);
  const threadOrder = opts.threadOrder ?? loadThreadOrder(repoPath);

  // 1. Cache + bd-ready read.
  const cache = opts.bdReady ?? getBdReady(repoPath, { ttlSeconds, force: opts.force });

  // I-BD3: surface cache lifecycle to the daily audit NDJSON so the
  // operator can see staleness via the log, not only via `result.cache`.
  // `getBdReady` always refreshes on a stale read (ready_cache.ts:119-141),
  // so `stale && !refreshed` is unreachable and intentionally not branched.
  if (cache.stale && cache.refreshed) {
    recordEvent("BD_READY_CACHE_STALE_SERVED", { deps: opts.auditDeps });
    recordEvent("BD_READY_CACHE_REFRESHED", { deps: opts.auditDeps });
  } else if (cache.refreshed) {
    recordEvent("BD_READY_CACHE_REFRESHED", { deps: opts.auditDeps });
  } else {
    recordEvent("BD_READY_CACHE_HIT", { deps: opts.auditDeps });
  }

  // 2. Parity-chain board with terminal-authority overrides applied.
  const board = opts.board ?? boardStatus(repoPath, runner);
  const reconciledUnits = opts.board
    ? board.units
    : applyAuthorityOverrides(board.repo, board.units, runner);

  const openBdIds = new Set<string>();
  for (const c of cache.cache.ready) openBdIds.add(c.id);
  for (const c of cache.cache.blocked) openBdIds.add(c.id);

  // 3. Index BoardUnits by both ticket (e.g., "GH-1510") and inferred GH
  // issue number so the join is stable when bd only carries an
  // external_ref URL and the board only carries the GH-NNN ticket label.
  const unitsByTicket = new Map<string, BoardUnit>();
  for (const unit of reconciledUnits) {
    if (unit.ticket) unitsByTicket.set(unit.ticket, unit);
  }
  const matchedUnitIds = new Set<BoardUnit>();
  function findUnit(bd: BdReadyCandidate): BoardUnit | null {
    for (const [ticket, unit] of unitsByTicket.entries()) {
      if (ticketIdToBdId(ticket, bd)) {
        matchedUnitIds.add(unit);
        return unit;
      }
    }
    return null;
  }

  // 4. Bucket candidates into threads. A given row lands in exactly one
  //    thread; precedence per the classification table in the GH-1510 plan.
  const buckets = new Map<NextWorkThreadKind, NextWorkCandidate[]>();
  // GH-1617 (I-NW3): track bd_id + GH-N ticket keys for each candidate
  // landing in a "board-column-wins" bucket (executor_in_flight,
  // pr_awaiting_ci, orphan_cleanup, ready_to_start). The plan_paused /
  // triage_backlog projectors consult this set to suppress duplicates.
  const SUPPRESSING_BUCKETS: ReadonlySet<NextWorkThreadKind> = new Set<NextWorkThreadKind>([
    "executor_in_flight",
    "pr_awaiting_ci",
    "orphan_cleanup",
    "ready_to_start",
  ]);
  const suppressedKeys = new Set<string>();
  function push(kind: NextWorkThreadKind, candidate: NextWorkCandidate): void {
    const existing = buckets.get(kind) ?? [];
    existing.push(candidate);
    buckets.set(kind, existing);
    if (SUPPRESSING_BUCKETS.has(kind)) {
      for (const key of suppressionKeysForCandidate(candidate)) {
        suppressedKeys.add(key);
      }
    }
  }

  for (const bd of cache.cache.ready) {
    const unit = findUnit(bd);
    if (unit) {
      if (unit.column === "cleanup_pending") {
        push(
          "orphan_cleanup",
          makeCandidate(
            bd,
            unit,
            "Issue closed or PR merged — orphan artifacts remain",
            recommendForColumn(unit),
          ),
        );
        continue;
      }
      if (unit.column === "ci_running") {
        push(
          "pr_awaiting_ci",
          makeCandidate(bd, unit, "CI in flight on open PR", recommendForColumn(unit)),
        );
        continue;
      }
      if (EXECUTOR_IN_FLIGHT_COLUMNS.has(unit.column)) {
        push(
          "executor_in_flight",
          makeCandidate(
            bd,
            unit,
            `Advance ${unit.column.replace("_", " ")}`,
            recommendForColumn(unit),
          ),
        );
        continue;
      }
      // Unit exists but no work in flight (no_worktree/branch_created/etc.)
      // → still ready-to-start, just with extant artifacts to resume.
      push(
        "ready_to_start",
        makeCandidate(bd, unit, "bd ready; resume existing worktree", recommendForColumn(unit)),
      );
      continue;
    }
    // No board unit for this bd row — it's pure ready_to_start (no
    // worktree yet). Recommend opening a session.
    const ticketGuess = extractGhIssueNumber(bd.external_ref);
    const command =
      ticketGuess !== null
        ? `prx plan agent GH-${ticketGuess} --create`
        : `prx plan agent ${bd.id} --create`;
    push("ready_to_start", makeCandidate(bd, null, "bd ready; no worktree yet", command));
  }

  for (const bd of cache.cache.blocked) {
    const unit = findUnit(bd);
    push(
      "blocked",
      makeCandidate(
        bd,
        unit,
        `Blocked by ${bd.blocked_by.map((b) => b.id).join(", ") || "unknown"}`,
        null,
      ),
    );
  }

  // 5. BoardUnits that did NOT join any bd row → intake backpressure.
  for (const unit of reconciledUnits) {
    if (matchedUnitIds.has(unit)) continue;
    if (unit.column === "merged" || unit.column === "cleaned") continue;
    if (unit.column === "cleanup_pending") {
      push("orphan_cleanup", {
        bd_id: unit.ticket ?? unit.branch,
        gh_issue: null,
        title: unit.pr.title ?? unit.branch,
        priority: 3,
        issue_type: "unknown",
        branch: unit.branch,
        worktree_path: unit.worktree_path,
        status: "open",
        blocked_by: [],
        reason: unit.reasons[unit.reasons.length - 1] ?? "Orphaned artifacts",
        command: recommendForColumn(unit),
      });
      continue;
    }
    push("intake_queue", {
      bd_id: unit.ticket ?? unit.branch,
      gh_issue: null,
      title: unit.pr.title ?? unit.branch,
      priority: 3,
      issue_type: "unknown",
      branch: unit.branch,
      worktree_path: unit.worktree_path,
      status: "open",
      blocked_by: [],
      reason: "No bd record for this worktree/branch",
      command: `prx intake propose ${unit.branch}`,
    });
  }

  // 5b. GH-1617: project the two reserved threads. Both run AFTER the bd-
  // ready loop so `suppressedKeys` is fully populated (I-NW3).
  const triageSnapshot = opts.triage ?? loadTriageSnapshot(repoPath);
  if (triageSnapshot) {
    projectTriageBacklog(triageSnapshot, buckets, suppressedKeys);
  }

  const transitionEntries = opts.transitionLog ?? loadTransitionLogForRepo(repoPath);
  const pausedTtl = opts.plannedPausedTtlSeconds ?? loadPausedPlanTtl(repoPath);
  const paused = derivePausedPlans(transitionEntries, opts.now ?? new Date(), pausedTtl);
  projectPlanPaused(paused, cache.cache.ready, buckets, suppressedKeys);

  // 6. Assemble ordered threads.
  const threads: NextWorkThread[] = [];
  for (const kind of threadOrder) {
    const rows = buckets.get(kind);
    if (!rows || rows.length === 0) {
      threads.push(emptyThread(kind));
      continue;
    }
    sortCandidates(rows);
    const head = threadHeadline(kind, rows.length);
    threads.push({
      kind,
      candidates: rows,
      recommended_action: rows[0]?.command ?? head.recommended,
      cost_of_context_switch: head.cost,
      reason: head.reason,
    });
    recordEvent("NEXT_WORK_THREAD_RANKED", {
      repo: board.repo,
      deps: opts.auditDeps,
      details: {
        kind,
        count: rows.length,
        top_bd_id: rows[0]?.bd_id ?? null,
      },
    });
  }

  const result: NextWorkResult = {
    source: "next-work",
    repo: board.repo,
    threads,
    cache: {
      queried_at: cache.cache.queried_at,
      stale: cache.stale,
      ttl_seconds: cache.cache.ttl_seconds,
      refreshed: cache.refreshed,
    },
  };

  recordEvent("NEXT_WORK_PROJECTED", {
    repo: board.repo,
    deps: opts.auditDeps,
    details: {
      threads: threads.length,
      top_thread: threads.find((t) => t.candidates.length > 0)?.kind ?? null,
    },
  });

  // Defense-in-depth: validate the picker's output at the boundary so a
  // future regression that drops a field surfaces here rather than in a
  // downstream surface.
  return NextWorkResultSchema.parse(result);
}
