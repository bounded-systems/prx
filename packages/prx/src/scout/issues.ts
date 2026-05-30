// GH-1244 — `scout issues`: read-only beads/Dolt projection. Reads the
// local substrate via `loadAllBeads` (no external HTTP), parses the
// conventional-commit `kind`/`scope` prefix off the title, projects the
// GH side via `externalRef`/`ghNumber`, and projects beads' native
// `Dependency` edges into a typed `links` field per spec §4. Sibling of
// `scout/grep.ts` / `scout/files.ts` / `scout/read.ts`; emits JSON-lines
// (one record per match plus a trailing `_summary`) so the dispatch
// envelope captures one CAS blob per invocation.
//
// Substrate decision (spec §1): beads is the corpus of record; GH is a
// projection out. This verb never re-fetches from GH — that's the fetch
// actor's job (GH-1245). When the fetch watermark column lands, the
// `_summary.substrateUpdatedAt` / `staleness` fields light up via the
// `readSubstrateWatermark` seam below.
//
// Decision (2026-05-02): native bd edges are the substrate, not body-
// embedded JSON-LD. `links` is projected from
// `bd list --json[].dependencies` (already populated upstream for records
// in the `Dependency` table); the parsing for that lives in `triage.ts`
// (`BeadsDependency`) so every `loadAllBeads` caller sees the same shape.

import {
  bdPriorityToLabel,
  extractIssueNumber,
  loadAllBeads as defaultLoadAllBeads,
  type BeadsRecord,
} from "../triage/triage.ts";
import { execBd } from "@bounded-systems/bd";
import {
  isMainxWorktree as defaultIsMainxWorktree,
  type CommandRunner as ScopeRunner,
} from "../pr-state/scope-inference.ts";
import { repoNameWithOwner as defaultRepoNameWithOwner } from "../pr-state/github.ts";
import { getLastPoints } from "../fetch/watermark.ts";
import {
  classifyStaleness as defaultClassifyStaleness,
  readSubstrateWatermark as defaultReadSubstrateWatermark,
  type Staleness,
} from "../fetch/freshness-gate.ts";

export type ScoutIssuesStateFilter = "open" | "closed" | "all";
export type ScoutIssuesFormat = "jsonl" | "plain";

export interface ScoutIssuesInput {
  /** Empty (or omitted) means "full snapshot — no filter". */
  query?: string | undefined;
  /** Default `"open"` per spec §3 defaults table. */
  state?: ScoutIssuesStateFilter | undefined;
  /** `owner/repo` filter; inferred from cwd when omitted. */
  repo?: string | undefined;
  /** Default unlimited; when set + exceeded, summary.truncated=true. */
  max?: number | undefined;
  /**
   * Duration string like `"24h"`; the threshold the read-time staleness
   * *report* is classified against. Scout never fetches on this — it only
   * labels the substrate fresh/stale. The decision to refresh belongs to the
   * fetch actor (GH-1245), not scout.
   */
  maxStaleness?: string | undefined;
  /** Output format (verb itself returns the same result either way). */
  format?: ScoutIssuesFormat;
  /** Working directory for cwd-based --repo inference. */
  cwd?: string;
  /** DI seam for bd. */
  execBd?: typeof execBd;
  /** DI seam composed with execBd. */
  loadAllBeads?: typeof defaultLoadAllBeads;
  /** DI seam for mainx detection (matches `prx intake` convention). */
  isMainxWorktree?: (cwd: string, runner?: ScopeRunner) => boolean;
  /** DI seam for owner/repo resolution from origin. */
  repoNameWithOwner?: typeof defaultRepoNameWithOwner;
  /** GH-1257 — DI seam for `prx.fetch.gh-issues.last-points` lookup. */
  readLastFetchPoints?: (cwd: string) => number | null;
  /** DI seam for the substrate watermark reader (staleness report only). */
  readSubstrateWatermark?: (cwd: string) => string | null;
  /** DI seam for the staleness clock. */
  now?: () => Date;
}

/**
 * One emitted JSONL row. Field set is fixed per spec §4 (operators write
 * downstream views against these names — drift here is breaking).
 */
export interface ScoutIssuesRow {
  id: string;
  ghNumber: number | null;
  state: string;
  title: string;
  kind: string | null;
  scope: string | null;
  priority: number | null;
  issueType: string;
  externalRef: string | null;
  sourceRepo: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  metadata: Record<string, unknown> | null;
  links: ScoutIssuesLink[];
}

export interface ScoutIssuesLink {
  kind: string;
  target: string;
}

export interface ScoutIssuesSummary {
  query: string;
  repo: string | null;
  state: ScoutIssuesStateFilter;
  total: number;
  truncated: boolean;
  snapshotAt: string;
  substrateUpdatedAt: string | null;
  staleness: Staleness;
  ratePoints: number | null;
}

export interface ScoutIssuesResult {
  rows: ScoutIssuesRow[];
  summary: ScoutIssuesSummary;
}

export class ScoutIssuesError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ScoutIssuesError";
    this.code = code;
  }
}

// `--state=open` is the GH-axis hot path (spec §5): bd's full status enum
// `open / in_progress / blocked / deferred` all count as "execution-open".
const OPEN_STATUSES: ReadonlySet<string> = new Set([
  "open",
  "in_progress",
  "blocked",
  "deferred",
]);
const CLOSED_STATUSES: ReadonlySet<string> = new Set(["closed"]);
// Tombstones are always excluded from v0 (spec §5). `--include-tombstone`
// is reserved for a future flag.
const TOMBSTONE_STATUS = "tombstone";

const CONVENTIONAL_COMMIT_RE = /^([A-Za-z][A-Za-z0-9_]*)(?:\(([^)]+)\))?/;

const OWNER_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const DEFAULT_MAX_STALENESS = "24h";

export async function runScoutIssues(
  input: ScoutIssuesInput = {},
): Promise<ScoutIssuesResult> {
  const max = input.max;
  if (max !== undefined && (!Number.isFinite(max) || max <= 0)) {
    throw new ScoutIssuesError("max must be a positive integer", "INVALID_MAX");
  }
  const cwd = input.cwd ?? process.cwd();
  const stateFilter: ScoutIssuesStateFilter = input.state ?? "open";
  const query = (input.query ?? "").trim();
  const repoFilter = resolveRepoFilter(input, cwd);
  const exec = input.execBd ?? execBd;
  const loader = input.loadAllBeads ?? defaultLoadAllBeads;
  const now = input.now ?? (() => new Date());
  const maxStaleness = input.maxStaleness ?? DEFAULT_MAX_STALENESS;
  const watermarkReader = input.readSubstrateWatermark ?? defaultReadSubstrateWatermark;

  // Scout reads the substrate as-is and *reports* its freshness; it never
  // triggers a fetch. The watermark + staleness label are a pure projection
  // of the local corpus's age. A caller that wants fresher data runs the
  // fetch actor (GH-1245) first — that decision is not scout's to make.
  const watermark = watermarkReader(cwd);

  let beads: BeadsRecord[];
  try {
    beads = loader(exec);
  } catch (err) {
    throw mapLoaderError(err);
  }

  const matched: BeadsRecord[] = [];
  for (const bead of beads) {
    if (bead.status === TOMBSTONE_STATUS) continue;
    if (!matchesState(bead.status, stateFilter)) continue;
    if (!matchesRepo(bead, repoFilter)) continue;
    if (query.length > 0 && !bead.title.toLowerCase().includes(query.toLowerCase())) {
      continue;
    }
    matched.push(bead);
  }

  const total = matched.length;
  const truncated = max !== undefined && total > max;
  const limit = max !== undefined ? Math.min(total, max) : total;

  const rows: ScoutIssuesRow[] = [];
  for (let i = 0; i < limit; i++) {
    rows.push(projectRow(matched[i] as BeadsRecord));
  }

  const pointsReader = input.readLastFetchPoints ?? readLastFetchPoints;
  const ratePoints = pointsReader(cwd);
  const summary: ScoutIssuesSummary = {
    query,
    repo: repoFilter,
    state: stateFilter,
    total,
    truncated,
    snapshotAt: now().toISOString(),
    substrateUpdatedAt: watermark,
    staleness: defaultClassifyStaleness(watermark, maxStaleness, now()),
    ratePoints,
  };

  return { rows, summary };
}

function matchesState(status: string, filter: ScoutIssuesStateFilter): boolean {
  if (filter === "open") return OPEN_STATUSES.has(status);
  if (filter === "closed") return CLOSED_STATUSES.has(status);
  return true;
}

function matchesRepo(bead: BeadsRecord, repoFilter: string | null): boolean {
  if (!repoFilter) return true;
  const ref = bead.externalRefs.gh ?? bead.externalRef;
  if (!ref) {
    // bd-only rows are included only when the inferred repo matches the
    // cwd's primary worktree (spec §5). The filter at this point IS the
    // inferred (or explicit) owner/repo, so a record with no external ref
    // is logically "in this repo" — emit it.
    return true;
  }
  const slug = extractOwnerRepoFromRef(ref);
  if (!slug) return false;
  return slug.toLowerCase() === repoFilter.toLowerCase();
}

export function extractOwnerRepoFromRef(ref: string): string | null {
  // Recognized shapes today: `https://github.com/<owner>/<repo>/issues/<n>`.
  const m = ref.match(/github\.com\/([^/\s]+)\/([^/\s]+?)\/issues\//i);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

function projectRow(bead: BeadsRecord): ScoutIssuesRow {
  const { kind, scope } = parseConventionalPrefix(bead.title);
  const ghRef = bead.externalRefs.gh ?? bead.externalRef;
  const ghNumber =
    bead.externalIssueNumber ?? extractIssueNumber(ghRef ?? null);
  const links: ScoutIssuesLink[] = [];
  for (const edge of bead.dependencies ?? []) {
    links.push({ kind: edge.type, target: edge.dependsOnId });
  }
  return {
    id: bead.id,
    ghNumber,
    state: bead.status,
    title: bead.title,
    kind,
    scope,
    priority: bead.priority,
    issueType: bead.issueType,
    externalRef: bead.externalRef ?? null,
    sourceRepo: ghRef ? extractOwnerRepoFromRef(ghRef) : null,
    // bd `created_at` is not currently captured by `loadAllBeads`; emit null
    // until the field is parsed (additive; out-of-scope for v0).
    createdAt: null,
    updatedAt: bead.updatedAt ?? null,
    metadata: bead.metadata,
    links,
  };
}

function parseConventionalPrefix(title: string): {
  kind: string | null;
  scope: string | null;
} {
  const m = title.match(CONVENTIONAL_COMMIT_RE);
  if (!m) return { kind: null, scope: null };
  // The regex matches any leading word; the conventional-commit contract
  // requires a `:` separator after the prefix. Reject matches that don't
  // see `:` immediately after the (kind)[(scope)] block — otherwise titles
  // like `the feature is broken` would project `kind: "the"`.
  const tail = title.slice(m[0].length);
  if (!tail.startsWith(":")) return { kind: null, scope: null };
  return {
    kind: (m[1] as string) ?? null,
    scope: m[2] ?? null,
  };
}

function resolveRepoFilter(input: ScoutIssuesInput, cwd: string): string | null {
  if (input.repo !== undefined) {
    if (!OWNER_REPO_RE.test(input.repo)) {
      throw new ScoutIssuesError(
        `--repo must be in owner/repo form (got: ${input.repo})`,
        "INVALID_REPO",
      );
    }
    return input.repo;
  }
  const isMainx = input.isMainxWorktree ?? defaultIsMainxWorktree;
  // `mainx` worktrees are explicitly excluded from cwd-based inference
  // (spec §5, mirrors `prx intake`). Run with no repo filter — operators
  // who care can pass `--repo` explicitly. We deliberately do NOT throw
  // here: a full-snapshot query in `mainx` is the audit case.
  if (isMainx(cwd)) return null;
  const repoFn = input.repoNameWithOwner ?? defaultRepoNameWithOwner;
  try {
    const inferred = repoFn(cwd).trim();
    if (inferred.length === 0) return null;
    return inferred;
  } catch {
    return null;
  }
}

function mapLoaderError(err: unknown): ScoutIssuesError {
  const msg = err instanceof Error ? err.message : String(err);
  // `loadAllBeads` wraps every bd failure with the `triage status:` prefix.
  // Translate the three distinguishable shapes back into spec §9 codes;
  // anything else collapses to BD_FAILED.
  if (/bd\s+list\s+--json\s+returned\s+invalid\s+JSON/i.test(msg)) {
    return new ScoutIssuesError(msg, "BD_INVALID_JSON");
  }
  if (/(ENOENT|not\s+found|command\s+not\s+found|bd:\s+command)/i.test(msg)) {
    return new ScoutIssuesError(msg, "BD_NOT_FOUND");
  }
  return new ScoutIssuesError(msg, "BD_FAILED");
}

/**
 * GH-1257 seam. Reads `prx.fetch.gh-issues.last-points` via
 * `getLastPoints` (src/fetch/watermark.ts). Returns `null` when the
 * fetch actor has not yet written the key — current default, since the
 * post-spike write path has not shipped. Any spawn failure also
 * degrades to `null`: scout already swallows watermark absence the same
 * way, and `ratePoints` is advisory cost-attribution metadata.
 */
function readLastFetchPoints(cwd: string): number | null {
  try {
    return getLastPoints({ cwd }).points;
  } catch {
    return null;
  }
}

// Reuse bdPriorityToLabel for downstream rendering when the operator
// passes --format=plain (the JSONL form keeps the numeric priority).
export { bdPriorityToLabel };

/**
 * Render a result as JSON-lines. One `JSON.stringify(row)` per match,
 * then one `{"_summary": …}` line. Trailing newline so the dispatch
 * envelope writes a clean CAS blob (mirrors `formatScoutGrepJsonLines`).
 */
export function formatScoutIssuesJsonLines(result: ScoutIssuesResult): string {
  const out: string[] = [];
  for (const row of result.rows) {
    out.push(JSON.stringify(row));
  }
  out.push(JSON.stringify({ _summary: result.summary }));
  return out.join("\n") + "\n";
}
