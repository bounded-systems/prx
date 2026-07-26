// The Front Desk ready source (GH-1010 — retire `bd ready`, sub-issue of
// GH-1008 "retire beads").
//
// prx's next-work picker used to read the ready queue by shelling `bd ready`
// (beads/ready.ts `queryBdReady`). This reads it from Front Desk instead — the
// verified scheduler's WSJF-ranked queue + mined dep-graph, off the GitHub API
// — by spawning the `fds graph` binary and mapping its GH-canonical output back
// into the bd read shapes the picker already parses (`BdReadyCandidate`).
//
// Why spawn `fds` and not import front-desk-scheduler: it is async (reads a
// dolt-server over the MySQL wire) but `queryBdReady` is SYNCHRONOUS. A single
// sync `fds graph` spawn keeps that signature — the same reason bd-door-dialer
// and the memory port (GH-1009) spawn rather than import. The capability
// boundary is the process boundary: `fds` holds the mirror credentials, prx
// does not. `fds` resolves on PATH (override PRX_FRONTDESK_BIN).
//
// Identity: Front Desk is GH-canonical, so a queue item maps to a synthetic bd
// id `GH-<number>` with `external_ref` set to the issue URL — the picker keys
// worktrees off the GH number (extractGhIssueNumber), so this lines up exactly.
// Scoped to the picker's repo so numbers don't collide across repos.

import { processEnv } from "@bounded-systems/env";
import { defaultRunner as procRunner, type CommandRunner } from "@bounded-systems/proc";
import {
  type BdReadyCandidate,
  BdReadyExplainEnvelopeSchema,
  type BdStatus,
  type QueryBdReadyResult,
} from "./ready.ts";

// The shape `fds graph --json` (FDS_JSON=1) emits. Kept local (a thin contract
// at the process boundary); validated structurally on parse.
interface FdsGraphRef {
  number: number;
  repository: string;
}
interface FdsGraphItem {
  number: number;
  repository: string;
  kind: string;
  title: string;
  status: string;
  effort: number;
  value: number;
  score: number;
  ageDays: number;
}
interface FdsGraphBlocked extends FdsGraphItem {
  blockedBy: FdsGraphRef[];
}
interface FdsGraphOutput {
  source: string;
  syncedAt: string | null;
  ready: FdsGraphItem[];
  blocked: FdsGraphBlocked[];
  edges: { from: FdsGraphRef; to: FdsGraphRef; kind: string }[];
}

export type FrontDeskSourceDeps = {
  /** Sync command runner (default: the ambient-authority-approved procRunner). */
  run?: CommandRunner | undefined;
  /** The `fds` executable (default: PRX_FRONTDESK_BIN ?? "fds"). */
  bin?: string | undefined;
  /** Ambient env source (default: the sanctioned processEnv). */
  env?: (() => Record<string, string>) | undefined;
};

const DEFAULT_FRONTDESK_BIN = "fds";

/** Front Desk status → bd status (the vocabularies the picker gates on). */
function toBdStatus(status: string): BdStatus {
  switch (status) {
    case "Todo":
      return "open";
    case "In Progress":
    case "In Review":
      return "in_progress";
    case "Blocked":
      return "blocked";
    case "Done":
      return "closed";
    default:
      return "open";
  }
}

/** The GH issue URL for a Front Desk item — `external_ref`, so the picker's
 *  `extractGhIssueNumber(/\/issues\/(\d+)/)` yields the number. */
function issueUrl(repository: string, number: number): string {
  return `https://github.com/bounded-systems/${repository}/issues/${number}`;
}

function toCandidate(
  it: FdsGraphItem,
  syncedAt: string | null,
  blockedBy: FdsGraphRef[],
): BdReadyCandidate {
  return {
    id: `GH-${it.number}`,
    title: it.title,
    status: toBdStatus(it.status),
    // Uniform priority: the queue is already WSJF-ordered, and the picker's
    // sort is stable — so a single priority preserves Front Desk's ranking.
    priority: 2,
    issue_type: it.kind,
    created_at: syncedAt ?? "",
    updated_at: syncedAt ?? "",
    external_ref: issueUrl(it.repository, it.number),
    source_system: "front-desk",
    labels: [],
    blocked_by: blockedBy.map((b) => ({ id: `GH-${b.number}`, status: "open" as const })),
    blocked_by_count: blockedBy.length,
    reason: `WSJF ${it.score}`,
  };
}

/** Resolve the Front Desk repo NAME (e.g. "prx") from a repo path's git origin. */
export function resolveRepoName(cwd: string, run: CommandRunner): string | undefined {
  const r = run(["git", "-C", cwd, "remote", "get-url", "origin"], { check: false });
  if (r.status !== 0) return undefined;
  const m = r.stdout.trim().match(/[/:]([^/]+?)(?:\.git)?$/);
  return m?.[1];
}

export type FrontDeskReadyOptions = {
  cwd: string;
  deps?: FrontDeskSourceDeps;
};

/**
 * Read the ready queue from Front Desk and shape it as `queryBdReady` would.
 * Throws (like the bd path) on an fds failure — the escape hatch is
 * `PRX_READY_SOURCE=bd`, surfaced in the error.
 */
export function frontDeskReady(opts: FrontDeskReadyOptions): QueryBdReadyResult {
  const run = opts.deps?.run ?? procRunner;
  const readEnv = opts.deps?.env ?? processEnv;
  const e = readEnv();
  const bin = opts.deps?.bin ?? e.PRX_FRONTDESK_BIN ?? DEFAULT_FRONTDESK_BIN;
  const repo = resolveRepoName(opts.cwd, run);

  const args = ["graph", ...(repo ? ["--repo", repo] : [])];
  const r = run([bin, ...args], { check: false, env: { ...e, FDS_JSON: "1" } });
  if (r.status !== 0) {
    throw new Error(
      `fds graph failed (exit ${r.status}): ${r.stderr.trim()} ` +
        `— set PRX_READY_SOURCE=bd to fall back to \`bd ready\`.`,
    );
  }

  const parsed = JSON.parse(r.stdout.trim()) as FdsGraphOutput;
  const ready = parsed.ready.map((it) => toCandidate(it, parsed.syncedAt, []));
  const blocked = parsed.blocked.map((it) => toCandidate(it, parsed.syncedAt, it.blockedBy));

  // Sanity: the same schema the bd path validates against, so a shape drift
  // fails loudly here rather than deep in the picker.
  const envelope = BdReadyExplainEnvelopeSchema.parse({ ready, blocked });
  return { ready: envelope.ready, blocked: envelope.blocked, raw: r.stdout };
}
