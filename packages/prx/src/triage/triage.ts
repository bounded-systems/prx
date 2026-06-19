// `prx triage status` (GH-306, GH-916) — read-only listing of GH↔beads
// contract gaps before promoting intake into the execution queue.
//
// Per workflows/triage.md, an issue is untriaged for *execution* when any of:
// no scored priority::* label (priority::none counts as untriaged per GH-970),
// multiple ambiguous scored priorities, no type::* label, or no beads record
// whose external_ref points at /issues/<n>. Note: the workflow also defines a
// *Declined* terminal state (priority::none with an explanatory comment); this
// command reports only the "not yet accepted into execution" criteria and does
// not filter out declined issues.
//
// GH-916 widens the surface from the GH→bead direction only to also report:
//   - reverse orphans: open beads with no `external_ref` (one of the two
//     halves of the 1:1 contract that was previously invisible to triage).
//   - pair drift: paired GH↔bead records whose title / status / type /
//     priority disagree.
//
// Status drift (`findDrift`) is one-directional: it iterates open GH issues,
// so it detects `bd closed ↔ gh open` but structurally cannot see a closed GH
// issue. GH-1588 closes that gap with a separate `stale` bucket: open beads
// whose linked GH issue is CLOSED ("merge-without-close drift" — a PR merged +
// the issue closed, but the beads mirror never got the close). It is
// report-only here; remediation is owned by GH-941 (`triage apply` propagates
// state/state-reason) and GH-1537 (periodic sync job). The closed-issue lookup
// is hybrid: we only spend an extra `gh issue list --state closed` call when a
// candidate exists (an open bead linked to an issue not in the open set), and
// that list is bounded by `--limit` — so a bead linked to a closed issue older
// than the window stays un-flagged, and a deleted/cross-repo `external_ref`
// number that isn't in the fetched closed set is silently skipped (the same
// blind spot `findDrift` / `indexBeadsByIssueNumber` already have). Repair /
// two-way reconcile is out of scope (see #872).
//
// Triage sits upstream of the parity chain (same position as `prx intake`)
// and produces no XState events. This module only reads; it never writes to
// bd or gh.
//
// GH-1573: the bd-side fetch for `prx triage status` runs via `bd sql
// --readonly` rather than `bd list --all --json` — the queue is multi-MB and
// most of that volume is the `description` column, which triage never reads.
// The scoped projection drops `description` outright and filters to
// join-relevant rows only: every non-closed bead (reverse-orphan / drift /
// stale candidates) plus every closed bead with a GH `external_ref` (so the
// `bd-closed ↔ gh-open` arm of `findDrift` stays detectable). The only rows
// dropped at the wire are closed bd-only memos with no external link — which
// triage has no use for. `loadAllBeads` is unchanged and still serves the
// other callers (intake, drift-fix, promote-children, etc.).
import { processEnv } from "@bounded-systems/env";
import { join } from "node:path";

import { z } from "zod";

import { execBd, type BdExecResult } from "@bounded-systems/bd";
import { adapterForDomain } from "../adapters/domain-adapter.ts";
import { isEmbeddedDoltMode } from "../beads/hydrate.ts";
import { localRepoForCwd, repoCanonical, repoStaleThresholdDays } from "../pr-state/repos.ts";
import {
  listOpenIssues as defaultListOpenIssues,
  listIssuesByState as defaultListIssuesByState,
  repoNameWithOwner as defaultRepoNameWithOwner,
  type FallbackIssue,
} from "../pr-state/github.ts";
import {
  estimateSweepCost as defaultEstimateSweepCost,
  formatBudgetBlock,
  refreshBudget as defaultRefreshBudget,
  type BudgetSnapshot,
  type SweepCostEstimate,
} from "@bounded-systems/github-budget";
import { withGhTruthReason } from "@bounded-systems/audit-context";
import {
  classifyStaleness as classifyFreshnessGateStaleness,
  defaultSubstrateRefresher as defaultFreshnessGateRefresher,
  readSubstrateWatermark as readFreshnessGateWatermark,
  type SubstrateRefresher as ScoutSubstrateRefresher,
} from "../fetch/freshness-gate.ts";
import { BD_TYPE_ENUM, parseLabelName, resolveBdTypeFromLabels } from "./labels.ts";

export const triageStatusOptionsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  format: z.enum(["plain", "json"]).default("plain"),
  limit: z.number().int().min(0).default(0),
  includeIntentional: z.boolean().default(false),
  rateLimit: z.boolean().default(false),
  // GH-1786 — read-time freshness budget for the substrate refresh trigger.
  // `--no-refresh` (sibling field) is the explicit opt-out for CI / scripted
  // contexts. Note: `prx scout issues` shares the staleness *budget* but no
  // longer refreshes — scout reports staleness and leaves fetching to the
  // fetch actor. The refresh trigger lives only here, on `triage status`.
  maxStaleness: z.string().trim().min(1).default("24h"),
  noRefresh: z.boolean().default(false),
});

export type TriageStatusOptions = z.infer<typeof triageStatusOptionsSchema>;

export type TriageMissingField = "priority" | "type" | "beads-link";

// Warn-only signals: areas where the schema admits a value but the issue is
// silent. Surfaced in the row render but **not** in the `missing` list, so a
// row missing only `area`/`effort` is NOT promoted into the untriaged report.
export type TriageWeakSignal = "area" | "effort";

export type TriageIssueRow = {
  number: number;
  title: string;
  url: string;
  labels: string[];
  beadsId: string | null;
  missing: TriageMissingField[];
  // Labels present on the issue that are not in the prx Zod vocab — warn-only,
  // not added to `missing`. Surfaces legacy labels (`agent::architect`,
  // `blocker`, etc.) and typos so operators can clean them up.
  unknownLabels: string[];
  // Optional axes (`area`, `effort`) that the schema admits but the issue is
  // missing. Warn-only — does not push the row into the untriaged filter.
  weakSignals: TriageWeakSignal[];
};

export type ReverseOrphanRow = {
  beadsId: string;
  title: string;
  status: string;
  priority: string;
  issueType: string;
  reason: "no-external-ref";
};

export type DriftFieldPair<TGh, TBd> = {
  gh: TGh;
  bd: TBd;
};

export type DriftRow = {
  issueNumber: number;
  beadsId: string;
  fields: {
    title?: DriftFieldPair<string, string> | undefined;
    status?: DriftFieldPair<"open", "closed"> | undefined;
    type?: DriftFieldPair<string | null, string> | undefined;
    priority?: DriftFieldPair<string | null, string> | undefined;
  };
};

// GH-1588: an open bead whose linked GH issue is CLOSED. Report-only — the fix
// (closing the bead / propagating state-reason) is owned by GH-941 / GH-1537.
export type StaleRow = {
  beadsId: string;
  issueNumber: number; // the CLOSED GH issue
  url: string; // external_ref (the GH issue URL)
  title: string; // bead title
  status: string; // bead status (open / in_progress / blocked)
  priority: string; // bdPriorityToLabel(bead.priority)
  issueType: string; // bead issue_type
  reason: "gh-issue-closed";
};

// GH-1710: bd-canonical row shapes. The bd substrate stores priority as a
// numeric field (0..3) and type as a string column — there are no `priority::*`
// or `type::*` labels on a bd record. An "untriaged" bead is one missing the
// priority/issueType the operator would normally stamp.
export type BdUntriagedRow = {
  beadsId: string;
  title: string;
  status: string;
  priority: string; // bdPriorityToLabel(record.priority); "unknown" when null.
  issueType: string;
  missing: Array<"priority" | "type">;
};

export type BdStaleRow = {
  beadsId: string;
  title: string;
  status: string;
  priority: string;
  issueType: string;
  lastTouched: string; // ISO timestamp (updated_at).
  daysSince: number;
};

// GH-1449: an open GH issue carrying ≥2 mutually-exclusive labels on the same
// axis (`type::*` / `priority::*` / `area::*` / `effort::*`). Report-only —
// remediation (operator policy: replace? prompt?) lives in a follow-up ticket.
// The bd substrate has no axis labels, so canonical=bd repos always emit `[]`.
export type AxisConflictRow = {
  number: number;
  title: string;
  url: string;
  conflicts: Array<{
    axis: "type" | "priority" | "area" | "effort";
    values: string[];
  }>;
};

export type TriageStatusResult = {
  repo: string;
  /**
   * GH-1710: resolved canonical axis at runtime — `"gh"` (default) preserves
   * today's behavior; `"bd"` switches to the bd-only projection.
   */
  canonical: "gh" | "bd";
  totalOpen: number;
  totalUntriaged: number;
  totalReverseOrphans: number;
  totalDrift: number;
  totalStale: number;
  /** GH-1449: count of open GH issues with ≥1 axis exclusivity violation. */
  totalAxisConflicts: number;
  /** Populated when canonical=gh; empty on canonical=bd. */
  issues: TriageIssueRow[];
  /** Populated when canonical=gh; empty on canonical=bd. */
  reverseOrphans: ReverseOrphanRow[];
  /** Populated when canonical=gh; empty on canonical=bd. */
  drift: DriftRow[];
  /** Populated when canonical=gh; canonical=bd uses {@link bdStale}. */
  stale: StaleRow[];
  /** GH-1449: populated when canonical=gh; always empty on canonical=bd. */
  axisConflicts: AxisConflictRow[];
  /** GH-1710: populated when canonical=bd; empty otherwise. */
  bdUntriaged?: BdUntriagedRow[] | undefined;
  /** GH-1710: populated when canonical=bd; empty otherwise. */
  bdStale?: BdStaleRow[] | undefined;
  rateLimit?:
    | {
        snapshots: BudgetSnapshot[];
        estimate: SweepCostEstimate;
      }
    | undefined;
};

export type TriageStatusDeps = {
  listOpenIssues?: typeof defaultListOpenIssues;
  listIssuesByState?: typeof defaultListIssuesByState;
  repoNameWithOwner?: typeof defaultRepoNameWithOwner;
  execBd?: typeof execBd;
  cwd?: () => string;
  refreshBudget?: typeof defaultRefreshBudget;
  estimateSweepCost?: typeof defaultEstimateSweepCost;
  /**
   * GH-1710: resolves the cwd to its `.prx/repos/index.json` entry so the
   * status actor can read `canonical` + `stale_threshold_days`. Injectable
   * for tests so they can mock a `canonical="bd"` repo without writing a
   * real index.
   */
  localRepoForCwd?: typeof localRepoForCwd;
  /** GH-1710: clock for the bd-canonical stale-threshold comparison. */
  now?: () => Date;
  /**
   * GH-1786 — read-time freshness gate. Mirrors the same seam shape as
   * `runScoutIssues`; both verbs share the watermark + refresher contract
   * so a stale read on either surface triggers exactly one fetch refresh.
   */
  readSubstrateWatermark?: (cwd: string) => string | null;
  /** GH-1786 — substrate refresher (defaults to `runFetchGhIssues`). */
  refreshSubstrate?: ScoutSubstrateRefresher;
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type BeadsRecord = {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number | null;
  issueType: string;
  /** Legacy GH single-pin slot (unchanged): the `bd update --external-ref` URL. */
  externalRef: string | null;
  /**
   * Multi-domain external-id map (`domain → externalId`) derived at parse
   * time from `metadata.external_refs` plus a back-compat fall-through from
   * the legacy `external_ref` slot when it is a GH-shaped issue URL. The
   * post-GH-1500-amendment UoW shape: a bd record can mirror to multiple
   * external DBs simultaneously (`{gh: …, notion: …}`). GH-1538.
   */
  externalRefs: Record<string, string>;
  metadata: Record<string, unknown> | null;
  externalIssueNumber: number | null;
  /**
   * bd's legacy `source_system` slot (e.g. `github:204`). Preserved verbatim
   * so callers like `findBeadsIssuesByGithubIssue` can still match the
   * `:<n>`-suffix path next to the `external_ref` URL match (GH-1595).
   */
  sourceSystem: string | null;
  /**
   * GH-1513: the bd `updated_at` timestamp (ISO-8601). Used by `prx memory
   * compact` as the closed-age proxy — bd does not expose an explicit
   * closed-at column, so the last-update timestamp is the conservative
   * stand-in (touching a closed record refreshes the age clock, which is
   * the desired behavior for opt-out via metadata edits). Optional because
   * `loadJoinRelevantBeads` (scoped projection) and many test fixtures omit
   * the field; `loadAllBeads` populates it from the bd source JSON.
   */
  updatedAt?: string | null | undefined;
  /**
   * GH-1244: outgoing dependency edges, as bd exposes them on `bd list
   * --json` for records that participate in the `Dependency` table. One
   * entry per outgoing edge (where this record is the `FromID`). Optional
   * because `loadJoinRelevantBeads` and existing fixtures omit it;
   * `loadAllBeads` populates it from the source JSON when present, so the
   * field is empty (not absent) for records with no edges in the live
   * substrate.
   */
  dependencies?: BeadsDependency[];
  /**
   * GH-1829: bd's `notes` column. Read by `findDrift` to detect the §6
   * "duplicate of canonical" marker so close-as-dup beads with an open
   * canonical sibling on the same `external_ref` are not flagged as drift.
   * Optional — `loadAllBeads` populates it from `bd list --json` when bd
   * emits it (best-effort; embedded-mode fallback may leave it `null`);
   * `loadJoinRelevantBeads` projects it from the canonical SQL path.
   */
  notes?: string | null;
  /**
   * GH-1508: bd's `created_at` ISO-8601 timestamp. Used by
   * `prx doctor dedupe-bd` as the secondary tie-break (earlier wins) per
   * ADR §6 when the auto-vs-manual id-shape heuristic does not split a
   * cluster. Optional because the scoped SQL projection
   * (`loadJoinRelevantBeads`) and existing fixtures omit it.
   */
  createdAt?: string | null;
  /**
   * GH-1508: bd's `started_at` ISO-8601 timestamp. Populated when a bead
   * has been claimed (status transitioned `in_progress` or further).
   * Used by `prx doctor dedupe-bd` to gate the §6 conflict-abort: if
   * BOTH siblings on a pin carry execution state, the cluster is
   * surfaced as a conflict and skipped — operators must reconcile by
   * hand.
   */
  startedAt?: string | null;
  /**
   * GH-1508: bd's `assignee` column (`Name <email>` string or null).
   * Companion to `startedAt` for the §6 conflict-abort gate — either
   * field alone counts as "has execution state" since some workflows
   * assign without an explicit start, and some start without an
   * explicit assignee.
   */
  assignee?: string | null;
};

/**
 * GH-1244: shape of one row in `bd list --json[].dependencies`. The four
 * `type` values match beads' upstream `Dependency.Type` enum (`blocks`,
 * `parent-child`, `related`, `discovered-from`). `issueId` is the source
 * (the record carrying the field — `FromID`); `dependsOnId` is the target
 * (`ToID`). Extra columns (`created_at`, `created_by`, `metadata`) are
 * dropped at parse time — scout only projects `{kind, target}`.
 */
export type BeadsDependency = {
  issueId: string;
  dependsOnId: string;
  type: string;
};

// Local GH-URL shape used as the back-compat fallback when no GH adapter is
// registered (e.g. an isolated unit test that imports triage without the
// adapter side-effect). The registered GH adapter's `recognizesExternalId`
// is the authoritative check in production.
const LEGACY_GH_ISSUE_URL_RE =
  /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/i;

const ISSUE_REF_RE = /\/issues\/(\d+)(?:[/?#].*)?$/;

export function extractIssueNumber(externalRef: string | null | undefined): number | null {
  if (!externalRef) return null;
  const match = externalRef.match(ISSUE_REF_RE);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

// bd numeric priority (0=highest) → workflow label name. See
// workflows/triage.md and `bd create --priority` semantics.
export function bdPriorityToLabel(priority: number | null | undefined): string {
  if (priority === 0) return "critical";
  if (priority === 1) return "high";
  if (priority === 2) return "medium";
  if (priority === 3) return "low";
  return "unknown";
}

// Inverse of bdPriorityToLabel: workflow label name → bd numeric priority
// passed to `bd create --priority`. Used by `prx triage promote` (GH-936) to
// translate the GH-918 priority axis into bd's 0–3 enum.
export function priorityToBdNumber(label: "critical" | "high" | "medium" | "low"): number {
  if (label === "critical") return 0;
  if (label === "high") return 1;
  if (label === "medium") return 2;
  return 3;
}

export function loadAllBeads(
  exec: typeof execBd = execBd,
  warn: (line: string) => void = () => {},
  cwd?: string,
): BeadsRecord[] {
  const result: BdExecResult = exec(
    {
      subcommand: "list",
      args: ["--all", "--json", "--limit", "0"],
      state: "planning",
      role: "planner",
      ...(cwd ? { cwd } : {}),
    },
    processEnv(),
  );

  // Parse stdout BEFORE judging the exit code. `bd list` can exit non-zero from
  // a *post-listing* side-effect (dolt auto-sync against a divergent remote;
  // cf. GH-826/GH-1112) while still having emitted a complete, valid array — so
  // a non-zero exit alone must not knock out triage/intake's beads leg.
  let raw: unknown;
  let parseError = false;
  try {
    raw = JSON.parse(result.stdout || "[]");
  } catch {
    parseError = true;
  }
  const parsedArray = !parseError && Array.isArray(raw) ? (raw as unknown[]) : null;
  // A *non-empty* parsed array proves the listing actually ran. Empty stdout
  // (which `|| "[]"` coerces to `[]`) does NOT — that's the shape bd produces
  // when it never printed anything (blocked subcommand, bd missing, crash).
  const listingRan = parsedArray !== null && result.stdout.trim().length > 0;

  if (result.exitCode !== 0) {
    if (listingRan) {
      const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
      warn(
        `triage status: bd list --all --json --limit 0 exited non-zero but emitted a valid array; using parsed output (${detail})`,
      );
    } else {
      const detail = result.stderr.trim() || result.stdout.trim() || "bd list --json failed";
      throw new Error(`triage status: ${detail}`);
    }
  } else if (parseError) {
    throw new Error("triage status: bd list --json returned invalid JSON");
  } else if (parsedArray === null) {
    throw new Error("triage status: expected bd list --json to return an array");
  }

  return parseBeadsRecords(parsedArray ?? []);
}

/**
 * Transform one raw `bd --json` entry (snake_case fields) into a parsed
 * {@link BeadsRecord} (camelCase + derived `externalRefs` /
 * `externalIssueNumber`). Returns null for non-objects or entries without a
 * string `id` (skipped by the bulk path).
 *
 * GH-296: extracted so the beadsd-routed readers (`beadsd/reads.ts`) apply the
 * SAME transform — the daemon returns raw `bd --json`, so host code must parse
 * it identically to the local `bd list` path. Without this, daemon results
 * carried snake_case fields cast blindly to `BeadsRecord` (e.g. `.externalRef`
 * undefined).
 */
export function parseBeadsRecord(entry: unknown): BeadsRecord | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : null;
  if (!id) return null;
  const externalRef = typeof record.external_ref === "string" ? record.external_ref : null;
  const metadata =
    record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : null;
  const externalRefs = deriveExternalRefs(id, externalRef, metadata);
  const dependencies = parseDependencies(record.dependencies);
  return {
    id,
    title: typeof record.title === "string" ? record.title : "",
    description: typeof record.description === "string" ? record.description : "",
    status: typeof record.status === "string" ? record.status : "open",
    priority: typeof record.priority === "number" ? record.priority : null,
    issueType: typeof record.issue_type === "string" ? record.issue_type : "",
    externalRef,
    externalRefs,
    metadata,
    externalIssueNumber: extractIssueNumber(externalRefs.gh ?? externalRef),
    sourceSystem: typeof record.source_system === "string" ? record.source_system : null,
    updatedAt: typeof record.updated_at === "string" ? record.updated_at : null,
    dependencies,
    notes: typeof record.notes === "string" ? record.notes : null,
    createdAt: typeof record.created_at === "string" ? record.created_at : null,
    startedAt: typeof record.started_at === "string" ? record.started_at : null,
    assignee: typeof record.assignee === "string" ? record.assignee : null,
  };
}

/** Parse a raw `bd --json` array into {@link BeadsRecord}s, skipping malformed entries. */
export function parseBeadsRecords(entries: unknown[]): BeadsRecord[] {
  const records: BeadsRecord[] = [];
  for (const entry of entries) {
    const parsed = parseBeadsRecord(entry);
    if (parsed) records.push(parsed);
  }
  return records;
}

/**
 * Derive the `{domain → externalId}` map from the raw bd record. Source order:
 *   1. `metadata.external_refs` (the post-GH-1500-amendment shape) — keys with
 *      non-empty string values are promoted; anything else is silently dropped
 *      (`metadata.external_refs` is a soft contract — bd-CLI does not validate
 *      it, so malformed shapes degrade to "no pin in that domain" rather than
 *      throwing).
 *   2. Legacy `external_ref` back-compat: when set and GH-shaped, write it to
 *      `externalRefs.gh`. Legacy wins on conflict — that's what
 *      `bd update --external-ref` writes today, so it is the source of truth
 *      for single-domain records. A divergent `metadata.external_refs.gh`
 *      triggers a warning so the operator can reconcile.
 */
function deriveExternalRefs(
  id: string,
  externalRef: string | null,
  metadata: Record<string, unknown> | null,
): Record<string, string> {
  const externalRefs: Record<string, string> = {};
  const metadataRefs =
    metadata &&
    metadata.external_refs &&
    typeof metadata.external_refs === "object" &&
    !Array.isArray(metadata.external_refs)
      ? (metadata.external_refs as Record<string, unknown>)
      : null;
  if (metadataRefs) {
    for (const [domain, value] of Object.entries(metadataRefs)) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed.length === 0) continue;
      externalRefs[domain] = trimmed;
    }
  }
  if (externalRef && externalRef.trim().length > 0) {
    const trimmedLegacy = externalRef.trim();
    const ghAdapter = adapterForDomain("gh");
    const isGhShape = ghAdapter
      ? ghAdapter.recognizesExternalId(trimmedLegacy)
      : LEGACY_GH_ISSUE_URL_RE.test(trimmedLegacy);
    if (isGhShape) {
      const fromMetadata = externalRefs.gh;
      if (fromMetadata && fromMetadata !== trimmedLegacy) {
        console.warn(
          `triage: bead ${id} has divergent gh pins (external_ref=${trimmedLegacy} vs metadata.external_refs.gh=${fromMetadata}); using legacy external_ref`,
        );
      }
      externalRefs.gh = trimmedLegacy;
    }
  }
  return externalRefs;
}

/**
 * GH-1244: parse the `dependencies` array bd emits on `list --json` for
 * records that participate in the `Dependency` table. Entries with the
 * upstream shape `{issue_id, depends_on_id, type, ...}` are projected to
 * the typed `BeadsDependency` shape; malformed rows are silently dropped
 * (soft contract — bd may extend the shape, and a parse failure should
 * degrade to "no edges" rather than blow up `loadAllBeads`).
 */
function parseDependencies(raw: unknown): BeadsDependency[] {
  if (!Array.isArray(raw)) return [];
  const out: BeadsDependency[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const issueId = typeof row.issue_id === "string" ? row.issue_id : null;
    const dependsOnId = typeof row.depends_on_id === "string" ? row.depends_on_id : null;
    const type = typeof row.type === "string" ? row.type : null;
    if (!issueId || !dependsOnId || !type) continue;
    out.push({ issueId, dependsOnId, type });
  }
  return out;
}

// GH-1573: scoped projection of `issues` used by `prx triage status`. Drops
// the `description` column (never read by triage) and filters to rows the
// GH↔bd join could plausibly need: every non-closed bead plus every closed
// bead with a GH `external_ref`. `loadAllBeads` stays for callers that
// genuinely need the full set.
//
// `bd sql --json` returns column values as the underlying DB stores them:
// `metadata` arrives as a JSON-encoded string (e.g. `"null"`, `"{}"`) rather
// than the already-parsed object you get from `bd list --json`. We parse it
// inline and shape the result to the same `BeadsRecord` (with
// `description: ""`) so downstream code is identical, including the
// `externalRefs` map produced by `deriveExternalRefs` (GH-1538).
const sqlBeadRowSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  priority: z.number().nullable().optional(),
  issue_type: z.string().nullable().optional(),
  external_ref: z.string().nullable().optional(),
  source_system: z.string().nullable().optional(),
  // bd stores `metadata` as a TEXT column holding JSON. SQLite returns it
  // verbatim, so we get a string here even when bd's higher-level CLI would
  // surface a parsed object.
  metadata: z.string().nullable().optional(),
  // GH-1710: project `updated_at` so the bd-canonical `stale` bucket has a
  // last-touched timestamp to compare against the threshold. Inexpensive —
  // a small ISO string per row.
  updated_at: z.string().nullable().optional(),
  // GH-1829: project `notes` so `findDrift` can detect the §6
  // "duplicate of canonical" marker on closed-as-dup beads.
  notes: z.string().nullable().optional(),
});

const JOIN_RELEVANT_BEADS_QUERY =
  "SELECT id, title, status, priority, issue_type, external_ref, source_system, metadata, updated_at, notes " +
  "FROM issues " +
  "WHERE status != 'closed' OR external_ref IS NOT NULL";

export function loadJoinRelevantBeads(exec: typeof execBd = execBd): BeadsRecord[] {
  const result: BdExecResult = exec(
    {
      subcommand: "sql",
      args: ["--json", JOIN_RELEVANT_BEADS_QUERY],
      state: "planning",
      role: "planner",
    },
    processEnv(),
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "bd sql --json failed";
    throw new Error(`triage status: ${detail}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout || "[]");
  } catch {
    throw new Error("triage status: bd sql --json returned invalid JSON");
  }
  if (!Array.isArray(raw)) {
    throw new Error("triage status: expected bd sql --json to return an array");
  }
  const records: BeadsRecord[] = [];
  for (const entry of raw) {
    const parsed = sqlBeadRowSchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error(`triage status: bd sql --json row shape drift: ${parsed.error.message}`);
    }
    const row = parsed.data;
    const externalRef = row.external_ref ?? null;
    let metadata: Record<string, unknown> | null = null;
    if (typeof row.metadata === "string" && row.metadata.length > 0) {
      try {
        const parsedMeta = JSON.parse(row.metadata);
        if (parsedMeta && typeof parsedMeta === "object" && !Array.isArray(parsedMeta)) {
          metadata = parsedMeta as Record<string, unknown>;
        }
      } catch {
        // Tolerate malformed metadata: triage uses `metadata?.bd_only`
        // defensively, so a null fallback simply means "no bd_only marker".
        metadata = null;
      }
    }
    const externalRefs = deriveExternalRefs(row.id, externalRef, metadata);
    records.push({
      id: row.id,
      title: row.title ?? "",
      description: "",
      status: row.status ?? "open",
      priority: typeof row.priority === "number" ? row.priority : null,
      issueType: row.issue_type ?? "",
      externalRef,
      externalRefs,
      metadata,
      externalIssueNumber: extractIssueNumber(externalRefs.gh ?? externalRef),
      sourceSystem: row.source_system ?? null,
      // GH-1710: scoped projection now carries `updated_at` so the
      // bd-canonical `stale` bucket has a last-touched timestamp. Callers
      // that need it for non-stale purposes still go through `loadAllBeads`.
      updatedAt: row.updated_at ?? null,
      // GH-1829: project `notes` so `findDrift` can detect the §6
      // "duplicate of canonical" marker on closed-as-dup beads.
      notes: row.notes ?? null,
    });
  }
  return records;
}

/**
 * GH-1691: route the triage GH↔bd projection by bd's declared dolt mode.
 *
 * Per-project workspaces (the GH-1471 canonical layout) keep the GH-1573
 * scoped `bd sql --json` read — drops the multi-MB `description` column.
 *
 * Legacy embedded-mode workspaces (`.beads/metadata.json` `dolt_mode:
 * "embedded"`) fall back to `loadAllBeads` because upstream bd refuses
 * `bd sql` there (GH-1061 won't-do, relaxed only for per-project). The
 * fallback emits one warn line and pays the unscoped-read perf cost on
 * the legacy path; `prx triage status` becomes usable instead of
 * dead-ending the status line.
 *
 * Both branches yield the same `BeadsRecord[]` shape; downstream
 * (`indexBeadsByIssueNumber`, `findReverseOrphans`, `findDrift`,
 * `findStaleBeads`) is invariant to which read path produced the records.
 */
export function loadTriageScopedBeads(
  beadsDir: string,
  exec: typeof execBd = execBd,
  warn: (line: string) => void = () => {},
): BeadsRecord[] {
  if (isEmbeddedDoltMode(beadsDir)) {
    warn(
      "triage status: bd workspace is embedded-mode; bd sql unavailable, " +
        "using bd list fallback (GH-1691)",
    );
    return loadAllBeads(exec, warn);
  }
  return loadJoinRelevantBeads(exec);
}

export function indexBeadsByIssueNumber(records: BeadsRecord[]): Map<number, BeadsRecord> {
  const map = new Map<number, BeadsRecord>();
  for (const record of records) {
    if (record.externalIssueNumber !== null) {
      map.set(record.externalIssueNumber, record);
    }
  }
  return map;
}

/**
 * GH-1829: like `indexBeadsByIssueNumber` but preserves *all* records that
 * share an `external_ref` (the single-record map is last-wins). `findDrift`
 * uses it to detect the canonical-sibling pattern: when one bd row is the
 * §6-closed dup and another row on the same GH issue is open, the dup is
 * suppressed from drift. Other callers (`classifyIssue`, etc.) still want
 * the single-record map.
 */
export function indexBeadsByIssueNumberAll(records: BeadsRecord[]): Map<number, BeadsRecord[]> {
  const map = new Map<number, BeadsRecord[]>();
  for (const record of records) {
    if (record.externalIssueNumber === null) continue;
    const list = map.get(record.externalIssueNumber) ?? [];
    list.push(record);
    map.set(record.externalIssueNumber, list);
  }
  return map;
}

/**
 * GH-1829: the §6 "duplicate of canonical" marker. Workflows/ADR §6 declares
 * the canonical sibling on the same `external_ref` as the winner; operators
 * (and GH-1508 `prx doctor dedupe-bd`) record this verdict on the loser by
 * writing `duplicate of <bd-id> ... ADR §6` into bd's `notes` column. Both
 * anchors must be present: matching on `duplicate` alone would also fire on
 * unrelated mentions of the word.
 */
const ADR_SECTION_6_DUP_MARKER = /\bduplicate of\b[\s\S]*?\bADR §6\b/;

/**
 * GH-2378: defense-in-depth at the *recognition* layer. The `§` anchor in
 * `ADR_SECTION_6_DUP_MARKER` is non-ASCII, so any round-trip that ASCII-escapes
 * the note (e.g. `json.dumps(..., ensure_ascii=True)`, JSON export/import,
 * operator tooling) stores the literal 6-char sequence `§` instead of `§`.
 * That escaped form would silently fail the marker test and keep a closed-as-dup
 * record counted as a live cluster member, blocking drain. Restore the real `§`
 * before matching so externally-escaped notes still drain; correctly-stored
 * real-`§` notes are unaffected (no occurrence of the escape to rewrite).
 */
function normalizeDupCloseNote(notes: string): string {
  return notes.replace(/\\u00a7/gi, "§");
}

export function isCanonicalDupClose(notes: string | null | undefined): boolean {
  if (!notes) return false;
  return ADR_SECTION_6_DUP_MARKER.test(normalizeDupCloseNote(notes));
}

export function classifyIssue(
  issue: FallbackIssue,
  beadsByNumber: Map<number, BeadsRecord>,
): TriageIssueRow {
  const labelNames = (issue.labels ?? [])
    .map((label) => label?.name)
    .filter((name): name is string => typeof name === "string");

  const missing: TriageMissingField[] = [];
  const unknownLabels: string[] = [];
  const weakSignals: TriageWeakSignal[] = [];

  // Required-field check derived from the Zod vocab in ./labels.ts.
  // priority::none (GH-970) is in-vocab as the explicit unscored marker — it's
  // a known label but semantically *untriaged*, so we exclude it from the
  // scored set. An issue with only `priority::none` still counts as missing
  // priority. Multiple scored priorities are NOT collapsed into `missing` here
  // — GH-1449 surfaces them in the dedicated `axisConflicts` bucket so the
  // semantic categories don't share a row.
  const scoredPriorities = new Set<string>();
  let hasKnownType = false;
  let hasKnownArea = false;
  let hasKnownEffort = false;
  for (const name of labelNames) {
    const parsed = parseLabelName(name);
    if (!parsed.known) {
      unknownLabels.push(parsed.raw);
      continue;
    }
    if (parsed.axis === "priority" && parsed.value !== "none") {
      scoredPriorities.add(parsed.value);
    }
    if (parsed.axis === "type") hasKnownType = true;
    if (parsed.axis === "area") hasKnownArea = true;
    if (parsed.axis === "effort") hasKnownEffort = true;
  }

  if (scoredPriorities.size === 0) missing.push("priority");
  if (!hasKnownType) missing.push("type");
  if (!hasKnownArea) weakSignals.push("area");
  if (!hasKnownEffort) weakSignals.push("effort");

  const beadsRecord = beadsByNumber.get(issue.number) ?? null;
  if (!beadsRecord) missing.push("beads-link");

  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    labels: labelNames,
    beadsId: beadsRecord?.id ?? null,
    missing,
    unknownLabels,
    weakSignals,
  };
}

// prx-3f1: Under the beads-first model (bd is the source/first layer; GitHub is
// an opt-in projection per the GH-1500 authority ADR), a bead with no
// external_ref is the NORMAL, expected state — NOT an orphan that needs a GH
// backfill. This supersedes the GH-2011 'GitHub canonical' assumption. The rows
// returned here are INFORMATIONAL ONLY: they are surfaced for visibility but are
// no longer projected into triage_backlog candidates and no longer count toward
// the rate-limit sweep budget. The function is retained unchanged for JSON shape
// stability and the informational count.
export function findReverseOrphans(
  records: BeadsRecord[],
  includeIntentional: boolean,
): ReverseOrphanRow[] {
  const out: ReverseOrphanRow[] = [];
  for (const record of records) {
    if (record.status === "closed") continue;
    // Reverse orphan = no external_ref at all. A non-GH external_ref (e.g. a
    // Notion URL) means the bead is intentionally linked to another system,
    // not orphaned, so we don't flag it.
    if (record.externalRef !== null) continue;
    if (!includeIntentional && record.metadata?.bd_only === true) continue;
    out.push({
      beadsId: record.id,
      title: record.title,
      status: record.status,
      priority: bdPriorityToLabel(record.priority),
      issueType: record.issueType,
      reason: "no-external-ref",
    });
  }
  return out;
}

export function normalizeTitle(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function firstLabelValue(labels: string[], prefix: string): string | null {
  const match = labels.find((name) => name.startsWith(prefix));
  if (!match) return null;
  const value = match.slice(prefix.length);
  return value.length > 0 ? value : null;
}

export function findDrift(records: BeadsRecord[], openIssues: FallbackIssue[]): DriftRow[] {
  const beadsByNumber = indexBeadsByIssueNumber(records);
  const allByNumber = indexBeadsByIssueNumberAll(records);
  const out: DriftRow[] = [];
  for (const issue of openIssues) {
    let bead = beadsByNumber.get(issue.number);
    if (!bead) continue;

    // GH-2254 + GH-1829: when the bd record selected for this GH issue is
    // closed but an *open* sibling shares the same issue number, the open
    // record is the live canonical and the closed one is non-authoritative —
    // either a §6 "duplicate of canonical" closure (GH-1829) or a recycled-
    // short-id phantom (GH-2254: bd reuses short-ids after a record closes,
    // so a stale closed record can collide on the pin of a live one). Re-bind
    // drift evaluation to the open canonical so we neither emit a false
    // `gh=open / bd=closed` status row (which on 2026-05-28 misled triage into
    // closing 5 live issues) nor compute field drift against the stale phantom.
    //
    // This subsumes the original GH-1829 §6 guard: the recycled phantom carries
    // no §6 marker, so gating on `isCanonicalDupClose` let it slip through. With
    // no open sibling the closed record stands — a genuine close-vs-open drift
    // (e.g. a §6-closed bead with no open canonical) is still surfaced. The
    // single-record index is last-wins, so re-binding here is also what makes
    // the suppression order-independent.
    if (bead.status === "closed") {
      const closedId = bead.id;
      const openSibling = (allByNumber.get(issue.number) ?? []).find(
        (s) => s.id !== closedId && s.status === "open",
      );
      if (openSibling) bead = openSibling;
    }

    const fields: DriftRow["fields"] = {};

    if (normalizeTitle(issue.title) !== normalizeTitle(bead.title)) {
      fields.title = { gh: issue.title, bd: bead.title };
    }

    // GH-2375: a §6/dedupe duplicate-close carries zero "work shipped" signal —
    // `prx doctor dedupe-bd` closes the loser with the ADR §6 marker to mean
    // "this is a duplicate", not "the GH work is done". Emitting the close-the-GH
    // `status` drift for such a bead is exactly what produced the false
    // functional-ripple bulk-close (GH-693/696/697/698/699/700). The GH-1829
    // block above only suppresses the *whole row* when an open canonical sibling
    // exists; this guard extends the suppression to the no-open-sibling case the
    // functional-ripple incident hit (both dup and canonical ended up closed).
    // A dedupe-closed-only GH issue is remediated by reopening a tracking bead,
    // not by closing the issue. See docs/spikes/GH-2375-functional-ripple-tombstone.md.
    if (bead.status === "closed" && !isCanonicalDupClose(bead.notes)) {
      fields.status = { gh: "open", bd: "closed" };
    }

    const labelNames = (issue.labels ?? [])
      .map((label) => label?.name)
      .filter((name): name is string => typeof name === "string");

    // Drift on type/priority requires both sides to be set. A missing GH
    // label is *unset*, not a disagreement — that case is already surfaced
    // as `missing[type]` / `missing[priority]` in the forward-orphan list.
    // Likewise, `priority::none` on GH means *untriaged* per workflows/triage.md.
    //
    // The GH type is resolved through `resolveBdTypeFromLabels` so the GH-1489
    // spike marker is honored: a lone `type::spike` round-trips as `task`, and
    // a co-occurring `BD_TYPE_ENUM` `type::*` label wins regardless of GH label
    // order — so legacy spike-only issues don't surface as permanent drift.
    // See GH-1532.
    const ghType = resolveBdTypeFromLabels(labelNames);
    if (ghType !== null && bead.issueType && ghType !== bead.issueType) {
      fields.type = { gh: ghType, bd: bead.issueType };
    }

    const ghPriority = firstLabelValue(labelNames, "priority::");
    const bdPriority = bdPriorityToLabel(bead.priority);
    if (
      ghPriority !== null &&
      ghPriority !== "none" &&
      bdPriority !== "unknown" &&
      ghPriority !== bdPriority
    ) {
      fields.priority = { gh: ghPriority, bd: bdPriority };
    }

    if (Object.keys(fields).length > 0) {
      out.push({ issueNumber: issue.number, beadsId: bead.id, fields });
    }
  }
  return out;
}

// GH-1449: pure axis-exclusivity detector. Iterates open GH issues and emits a
// row for each issue carrying ≥2 mutually-exclusive labels on at least one
// axis. The per-axis rules:
//   - type: distinct BD_TYPE_ENUM members (the GH-1489 `type::spike` marker
//     rides alongside a BD_TYPE_ENUM stamp and is intentionally excluded from
//     the count — matches `resolveBdTypeFromLabels`).
//   - priority: distinct *scored* values (`priority::none` is the explicit
//     unscored marker per GH-970 and is excluded — see `classifyIssue`).
//   - area / effort: distinct in-vocab values (`parseLabelName` already gates
//     to the Zod enum; unknown labels never contribute).
// Each emitted axis's `values` list is the surfaced in-vocab set only.
export function findAxisConflicts(openIssues: FallbackIssue[]): AxisConflictRow[] {
  const out: AxisConflictRow[] = [];
  for (const issue of openIssues) {
    const labelNames = (issue.labels ?? [])
      .map((label) => label?.name)
      .filter((name): name is string => typeof name === "string");

    const typeValues = new Set<string>();
    const priorityValues = new Set<string>();
    const areaValues = new Set<string>();
    const effortValues = new Set<string>();

    for (const name of labelNames) {
      const parsed = parseLabelName(name);
      if (!parsed.known) continue;
      if (parsed.axis === "type") {
        if ((BD_TYPE_ENUM as readonly string[]).includes(parsed.value)) {
          typeValues.add(parsed.value);
        }
      } else if (parsed.axis === "priority") {
        if (parsed.value !== "none") priorityValues.add(parsed.value);
      } else if (parsed.axis === "area") {
        areaValues.add(parsed.value);
      } else if (parsed.axis === "effort") {
        effortValues.add(parsed.value);
      }
    }

    const conflicts: AxisConflictRow["conflicts"] = [];
    if (typeValues.size >= 2) conflicts.push({ axis: "type", values: [...typeValues] });
    if (priorityValues.size >= 2) {
      conflicts.push({ axis: "priority", values: [...priorityValues] });
    }
    if (areaValues.size >= 2) conflicts.push({ axis: "area", values: [...areaValues] });
    if (effortValues.size >= 2) conflicts.push({ axis: "effort", values: [...effortValues] });

    if (conflicts.length > 0) {
      out.push({ number: issue.number, title: issue.title, url: issue.url, conflicts });
    }
  }
  return out;
}

// GH-1588: pure half of the stale-bead detection. Given the set of GH issue
// numbers known to be CLOSED, emit a row for every non-closed bead linked to
// one of them. Mirrors `findReverseOrphans`'s shape (skip closed beads, skip
// beads with no GH `external_ref`).
export function findStaleBeads(
  records: BeadsRecord[],
  closedIssueNumbers: ReadonlySet<number>,
): StaleRow[] {
  const out: StaleRow[] = [];
  for (const record of records) {
    if (record.status === "closed") continue;
    if (record.externalIssueNumber === null) continue;
    if (!closedIssueNumbers.has(record.externalIssueNumber)) continue;
    out.push({
      beadsId: record.id,
      issueNumber: record.externalIssueNumber,
      url: record.externalRef ?? "",
      title: record.title,
      status: record.status,
      priority: bdPriorityToLabel(record.priority),
      issueType: record.issueType,
      reason: "gh-issue-closed",
    });
  }
  return out;
}

/**
 * GH-1808: stale-row derivation against pre-loaded gh-canonical state.
 * The hybrid `resolveClosedIssueNumbers` + `findStaleBeads` two-liner — wrapped
 * in `withGhTruthReason("stale-comparator", …)` for audit tagging — is shared
 * by `findStaleProjection`, `runTriageStatus`'s gh path, and `runStatusActor`'s
 * gh path. Centralizing here keeps the three call sites from drifting; the
 * runners already load `allBeads` + `openIssues` for *other* projections
 * (reverse-orphan / drift / untriaged), so calling this helper avoids the
 * double-fetch that wrapping `findStaleProjection` itself would impose.
 */
export function computeStaleRowsForGh(
  allBeads: BeadsRecord[],
  openIssues: FallbackIssue[],
  repo: string,
  ghLimit: number,
  listByState: typeof defaultListIssuesByState,
): StaleRow[] {
  const closedIssueNumbers = withGhTruthReason("stale-comparator", () =>
    resolveClosedIssueNumbers(allBeads, openIssues, repo, ghLimit, listByState),
  );
  return findStaleBeads(allBeads, closedIssueNumbers);
}

// GH-1588: IO half of stale-bead detection — hybrid lookup that avoids a
// `gh issue list --state closed` call when nothing could possibly be stale.
// 1. candidates = open beads with a GH `external_ref` not present in the open
//    set; 2. zero candidates → return `{}` (no extra `gh` call); 3. otherwise
//    one bulk closed-list fetch; intersect with the candidate set. The fetch is
//    bounded by `ghLimit` (the same `--limit` the open fetch uses), so a
//    closed issue older than that window — or a deleted/cross-repo number —
//    is silently skipped.
export function resolveClosedIssueNumbers(
  allBeads: BeadsRecord[],
  openIssues: FallbackIssue[],
  repo: string,
  ghLimit: number,
  listByState: typeof defaultListIssuesByState,
): Set<number> {
  const openSet = new Set<number>();
  for (const issue of openIssues) openSet.add(issue.number);

  const candidates = new Set<number>();
  for (const bead of allBeads) {
    if (bead.status === "closed") continue;
    if (bead.externalIssueNumber === null) continue;
    if (openSet.has(bead.externalIssueNumber)) continue;
    candidates.add(bead.externalIssueNumber);
  }
  if (candidates.size === 0) return new Set<number>();

  const closed = new Set<number>();
  for (const issue of listByState(repo, "closed", ghLimit)) {
    if (candidates.has(issue.number)) closed.add(issue.number);
  }
  return closed;
}

/**
 * GH-1710: untriaged-filter for bd-canonical repos. The bd substrate carries
 * priority as a numeric field (0..3) and `issue_type` as a string column;
 * there are no `priority::*` / `type::*` labels on a bd record. A bead is
 * "untriaged for execution" when either:
 *   - `priority === null` (no scored priority — analogous to no `priority::*`
 *     on a GH issue), or
 *   - `issueType === ""` (no type stamped).
 *
 * Mirrors the shape of {@link classifyIssue} so callers can present a
 * consistent row format. Closed beads and bd-only memo beads (where the
 * operator pinned `metadata.bd_only=true`) are skipped — the latter only when
 * `includeIntentional` is false, matching {@link findReverseOrphans}.
 */
export function findBdUntriaged(
  records: BeadsRecord[],
  includeIntentional: boolean,
): BdUntriagedRow[] {
  const out: BdUntriagedRow[] = [];
  for (const record of records) {
    if (record.status === "closed") continue;
    if (!includeIntentional && record.metadata?.bd_only === true) continue;
    const missing: Array<"priority" | "type"> = [];
    if (record.priority === null || record.priority === undefined) missing.push("priority");
    if (!record.issueType) missing.push("type");
    if (missing.length === 0) continue;
    out.push({
      beadsId: record.id,
      title: record.title,
      status: record.status,
      priority: bdPriorityToLabel(record.priority),
      issueType: record.issueType,
      missing,
    });
  }
  return out;
}

/**
 * GH-1710: stale-filter for bd-canonical repos — open beads whose
 * `updated_at` is older than `thresholdDays` days. The `last_touched > N`
 * semantics come from the issue body's bd-canonical bucket table; the
 * threshold is per-repo via `stale_threshold_days` on the inventory entry.
 *
 * Beads with no `updated_at` (legacy fixtures, embedded-mode workspaces) are
 * skipped rather than treated as infinitely stale — surfacing them as stale
 * would punish bd-mode users for substrate gaps rather than work-item
 * staleness.
 */
export function findBdStale(
  records: BeadsRecord[],
  thresholdDays: number,
  now: Date,
  includeIntentional: boolean,
): BdStaleRow[] {
  const out: BdStaleRow[] = [];
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
  const nowMs = now.getTime();
  for (const record of records) {
    if (record.status === "closed") continue;
    if (!includeIntentional && record.metadata?.bd_only === true) continue;
    if (!record.updatedAt) continue;
    const updatedAtMs = Date.parse(record.updatedAt);
    if (!Number.isFinite(updatedAtMs)) continue;
    const ageMs = nowMs - updatedAtMs;
    if (ageMs <= thresholdMs) continue;
    const daysSince = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    out.push({
      beadsId: record.id,
      title: record.title,
      status: record.status,
      priority: bdPriorityToLabel(record.priority),
      issueType: record.issueType,
      lastTouched: record.updatedAt,
      daysSince,
    });
  }
  return out;
}

/**
 * Actor-shaped entry for `prx triage status`. Returns the typed snapshot the
 * machine assigns into context, alongside captured stdout/stderr lines and
 * the underlying exit code. The default `runTriageStatus` exit-code function
 * stays untouched — the CLI dispatch keeps using it; the machine uses this.
 */
export type TriageStatusActorResult = {
  exitCode: number;
  snapshot: TriageStatusResult;
  stdout: string[];
  stderr: string[];
};

function attachRateLimit(
  base: TriageStatusResult,
  opts: TriageStatusOptions,
  deps: TriageStatusDeps,
): TriageStatusResult {
  if (!opts.rateLimit) return base;
  const refresh = deps.refreshBudget ?? defaultRefreshBudget;
  const estimate = deps.estimateSweepCost ?? defaultEstimateSweepCost;
  // prx-3f1: totalReverseOrphans is excluded — bd-native records (no external_ref)
  // are the expected beads-first state, not actionable sweep work, so they must
  // not inflate the rate-limit budget.
  const queueSize = base.totalUntriaged + base.totalDrift + base.totalAxisConflicts;
  const snapshots = refresh() ?? [];
  return {
    ...base,
    rateLimit: {
      snapshots,
      estimate: estimate(queueSize),
    },
  };
}

export type FindStaleProjectionResult = {
  repo: string;
  canonical: "gh" | "bd";
  rows: StaleRow[];
};

/**
 * Stale-only slice of `runTriageStatus`'s gh-canonical path — open beads whose
 * linked GH issue is closed. Self-contained: loads its own beads + open-issue
 * snapshot, then runs the same `resolveClosedIssueNumbers` + `findStaleBeads`
 * pipeline `runTriageStatus` uses. Bd-canonical repos return `rows: []` (no
 * `gh-issue-closed` axis exists when bd is the source of truth — the bd-side
 * `bdStale` projection is reported by `runTriageStatus` instead).
 *
 * Carved out for callers that only need the stale rows (`prx triage
 * close-stale`) without paying for the rest of the status snapshot or
 * round-tripping through `runTriageStatus`'s JSON stdout.
 */
export function findStaleProjection(
  opts: { repo?: string; limit?: number } = {},
  deps: TriageStatusDeps = {},
): FindStaleProjectionResult {
  const bdExec = deps.execBd ?? execBd;
  const cwd = (deps.cwd ?? process.cwd)();

  const localRepo = (deps.localRepoForCwd ?? localRepoForCwd)(cwd);
  const canonical: "gh" | "bd" = localRepo ? repoCanonical(localRepo) : "gh";

  if (canonical === "bd") {
    const repo =
      opts.repo ?? localRepo?.primaryRemote?.githubRepo ?? localRepo?.name ?? "<bd-canonical>";
    return { repo, canonical: "bd", rows: [] };
  }

  const listIssues = deps.listOpenIssues ?? defaultListOpenIssues;
  const listByState = deps.listIssuesByState ?? defaultListIssuesByState;
  const resolveRepo = deps.repoNameWithOwner ?? defaultRepoNameWithOwner;

  const repo = opts.repo ?? resolveRepo(cwd);
  const ghLimit = (opts.limit ?? 0) > 0 ? (opts.limit as number) : 1000;
  const openIssues = withGhTruthReason("drift-comparator", () => listIssues(repo, ghLimit));
  const allBeads = loadTriageScopedBeads(join(cwd, ".beads"), bdExec, () => {});
  const rows = computeStaleRowsForGh(allBeads, openIssues, repo, ghLimit, listByState);

  return { repo, canonical: "gh", rows };
}

export function runStatusActor(
  opts: TriageStatusOptions,
  deps: TriageStatusDeps = {},
): TriageStatusActorResult {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const bdExec = deps.execBd ?? execBd;
  const cwd = (deps.cwd ?? process.cwd)();

  // GH-1710: resolve canonical *before* hitting the GH wire. canonical="bd"
  // skips every `gh` call below — no `listOpenIssues`, no `listIssuesByState`.
  const localRepo = (deps.localRepoForCwd ?? localRepoForCwd)(cwd);
  const canonical: "gh" | "bd" = localRepo ? repoCanonical(localRepo) : "gh";

  if (canonical === "bd") {
    const allBeads = loadTriageScopedBeads(join(cwd, ".beads"), bdExec, (line) =>
      stderr.push(line),
    );
    const thresholdDays = localRepo ? repoStaleThresholdDays(localRepo) : 30;
    const now = (deps.now ?? (() => new Date()))();
    const openBeads = allBeads.filter((r) => r.status !== "closed");
    const bdUntriaged = findBdUntriaged(allBeads, opts.includeIntentional);
    const bdStale = findBdStale(allBeads, thresholdDays, now, opts.includeIntentional);
    const repo =
      opts.repo ?? localRepo?.primaryRemote?.githubRepo ?? localRepo?.name ?? "<bd-canonical>";
    const base: TriageStatusResult = {
      repo,
      canonical: "bd",
      totalOpen: openBeads.length,
      totalUntriaged: bdUntriaged.length,
      totalReverseOrphans: 0,
      totalDrift: 0,
      totalStale: bdStale.length,
      // GH-1449: bd substrate has no axis labels — axis-conflict detection is
      // categorically N/A on this branch.
      totalAxisConflicts: 0,
      issues: [],
      reverseOrphans: [],
      drift: [],
      stale: [],
      axisConflicts: [],
      bdUntriaged,
      bdStale,
    };
    const snapshot = attachRateLimit(base, opts, deps);
    stdout.push(formatTriageStatus(snapshot, opts.format));
    return { exitCode: 0, snapshot, stdout, stderr };
  }

  const listIssues = deps.listOpenIssues ?? defaultListOpenIssues;
  const listByState = deps.listIssuesByState ?? defaultListIssuesByState;
  const resolveRepo = deps.repoNameWithOwner ?? defaultRepoNameWithOwner;

  const repo = opts.repo ?? resolveRepo(cwd);
  const ghLimit = opts.limit > 0 ? opts.limit : 1000;
  // GH-1786 — read-time freshness gate. Before hitting GH (open issues) and
  // bd (scoped beads), check the substrate watermark and trigger one bounded
  // `runFetchGhIssues` refresh when it's stale (or unset). The GH-canonical
  // path keeps its existing `listOpenIssues` call — that one always queries
  // GH fresh — but the bd-side `loadTriageScopedBeads` below is the laggy
  // half, and gating it keeps the comparator direction-locked.
  applyFreshnessGate({ opts, deps, cwd, repo, log: (l) => stderr.push(l) });

  // GH-1602: `runStatusActor` is the one triage verb that intentionally keeps
  // gh as the source of truth — forward-orphan / drift / stale all need an
  // authoritative GH-side answer, not the bd mirror of it. Tag the residual
  // calls with the load-bearing reason so the audit log identifies a justified
  // comparator (vs. an accidental gh fallback the refactor missed). One read
  // serves forward-orphan + drift; the more specific drift-comparator wins.
  const openIssues = withGhTruthReason("drift-comparator", () => listIssues(repo, ghLimit));
  // GH-1573 routes the triage-status bd read through `bd sql --json` for
  // per-project workspaces (drops the multi-MB `description` column). GH-1691
  // adds the legacy embedded-mode fallback at the caller — upstream bd refuses
  // `bd sql` in embedded mode (GH-1061), so the router downgrades to the
  // unscoped `bd list --all --json` path. Neither read hits the non-zero-
  // exit-with-valid-stdout failure mode the GH-1551 parse-then-warn fix
  // covers, since the scoped path has no post-listing dolt sync.
  const allBeads = loadTriageScopedBeads(join(cwd, ".beads"), bdExec, (line) => stderr.push(line));
  const beadsByNumber = indexBeadsByIssueNumber(allBeads);

  const rows = openIssues
    .map((issue) => classifyIssue(issue, beadsByNumber))
    .filter((row) => row.missing.length > 0);

  const reverseOrphans = findReverseOrphans(allBeads, opts.includeIntentional);
  const drift = findDrift(allBeads, openIssues);
  const stale = computeStaleRowsForGh(allBeads, openIssues, repo, ghLimit, listByState);
  const axisConflicts = findAxisConflicts(openIssues);

  const base: TriageStatusResult = {
    repo,
    canonical: "gh",
    totalOpen: openIssues.length,
    totalUntriaged: rows.length,
    totalReverseOrphans: reverseOrphans.length,
    totalDrift: drift.length,
    totalStale: stale.length,
    totalAxisConflicts: axisConflicts.length,
    issues: rows,
    reverseOrphans,
    drift,
    stale,
    axisConflicts,
  };
  const snapshot = attachRateLimit(base, opts, deps);

  stdout.push(formatTriageStatus(snapshot, opts.format));
  return { exitCode: 0, snapshot, stdout, stderr };
}

export function runTriageStatus(
  opts: TriageStatusOptions,
  output: Output,
  deps: TriageStatusDeps = {},
): number {
  const bdExec = deps.execBd ?? execBd;
  const cwd = (deps.cwd ?? process.cwd)();

  // GH-1710: canonical-axis branch (parallels `runStatusActor`).
  const localRepo = (deps.localRepoForCwd ?? localRepoForCwd)(cwd);
  const canonical: "gh" | "bd" = localRepo ? repoCanonical(localRepo) : "gh";

  if (canonical === "bd") {
    const allBeads = loadTriageScopedBeads(join(cwd, ".beads"), bdExec, output.error);
    const thresholdDays = localRepo ? repoStaleThresholdDays(localRepo) : 30;
    const now = (deps.now ?? (() => new Date()))();
    const openBeads = allBeads.filter((r) => r.status !== "closed");
    const bdUntriaged = findBdUntriaged(allBeads, opts.includeIntentional);
    const bdStale = findBdStale(allBeads, thresholdDays, now, opts.includeIntentional);
    const repo =
      opts.repo ?? localRepo?.primaryRemote?.githubRepo ?? localRepo?.name ?? "<bd-canonical>";
    const base: TriageStatusResult = {
      repo,
      canonical: "bd",
      totalOpen: openBeads.length,
      totalUntriaged: bdUntriaged.length,
      totalReverseOrphans: 0,
      totalDrift: 0,
      totalStale: bdStale.length,
      // GH-1449: bd substrate has no axis labels — see `runStatusActor`.
      totalAxisConflicts: 0,
      issues: [],
      reverseOrphans: [],
      drift: [],
      stale: [],
      axisConflicts: [],
      bdUntriaged,
      bdStale,
    };
    const result = attachRateLimit(base, opts, deps);
    output.log(formatTriageStatus(result, opts.format));
    return 0;
  }

  const listIssues = deps.listOpenIssues ?? defaultListOpenIssues;
  const listByState = deps.listIssuesByState ?? defaultListIssuesByState;
  const resolveRepo = deps.repoNameWithOwner ?? defaultRepoNameWithOwner;

  const repo = opts.repo ?? resolveRepo(cwd);
  const ghLimit = opts.limit > 0 ? opts.limit : 1000;
  // GH-1786 — same read-time freshness gate as `runStatusActor`. Keeping it
  // on both entries means the verb's behavior is identical whether it went
  // through the actor or the legacy CLI handler.
  applyFreshnessGate({ opts, deps, cwd, repo, log: output.error });
  // GH-1602: parallels `runStatusActor`; the CLI path needs the same tagging
  // so the audit log doesn't fragment on whether the verb went via the actor
  // or the legacy CLI entry.
  const openIssues = withGhTruthReason("drift-comparator", () => listIssues(repo, ghLimit));
  // GH-1573: scoped `bd sql --json` read; GH-1691: legacy embedded-mode bd
  // workspaces fall back to `bd list --all --json` at the caller because
  // upstream bd refuses `bd sql` there. See `loadTriageScopedBeads`.
  const allBeads = loadTriageScopedBeads(join(cwd, ".beads"), bdExec, output.error);
  const beadsByNumber = indexBeadsByIssueNumber(allBeads);

  const rows = openIssues
    .map((issue) => classifyIssue(issue, beadsByNumber))
    .filter((row) => row.missing.length > 0);

  const reverseOrphans = findReverseOrphans(allBeads, opts.includeIntentional);
  const drift = findDrift(allBeads, openIssues);
  const stale = computeStaleRowsForGh(allBeads, openIssues, repo, ghLimit, listByState);
  const axisConflicts = findAxisConflicts(openIssues);

  const base: TriageStatusResult = {
    repo,
    canonical: "gh",
    totalOpen: openIssues.length,
    totalUntriaged: rows.length,
    totalReverseOrphans: reverseOrphans.length,
    totalDrift: drift.length,
    totalStale: stale.length,
    totalAxisConflicts: axisConflicts.length,
    issues: rows,
    reverseOrphans,
    drift,
    stale,
    axisConflicts,
  };
  const result = attachRateLimit(base, opts, deps);

  output.log(formatTriageStatus(result, opts.format));
  return 0;
}

/**
 * GH-1786 — read-time freshness gate. Reads the substrate watermark, and
 * if it's stale (or unset) and the caller has not opted out, triggers one
 * bounded `runFetchGhIssues` refresh before the verb hits `bd`. On refresh
 * failure the read continues against the still-stale substrate; the
 * structured reason is sent to the verb's stderr/stdout sink (output.error
 * via `runTriageStatus`, the actor stderr buffer via `runStatusActor`) so
 * the operator sees why the queue may be lagging GH.
 *
 * The gate is documentary inside the `prx` actor's accepted `status` op
 * (no new XState events, no new watermark key). The shared implementation
 * lives in `../fetch/freshness-gate.ts`.
 */
function applyFreshnessGate(args: {
  opts: TriageStatusOptions;
  deps: TriageStatusDeps;
  cwd: string;
  repo: string;
  log: (line: string) => void;
}): void {
  const { opts, deps, cwd, repo, log } = args;
  if (opts.noRefresh) return;
  const watermarkReader = deps.readSubstrateWatermark ?? readFreshnessGateWatermark;
  const watermark = watermarkReader(cwd);
  const now = (deps.now ?? (() => new Date()))();
  if (classifyFreshnessGateStaleness(watermark, opts.maxStaleness, now) === "fresh") return;
  const refresher = deps.refreshSubstrate ?? defaultFreshnessGateRefresher;
  const outcome = refresher({ repo, cwd });
  if (!outcome.ok) {
    log(`triage status: substrate refresh skipped — ${outcome.reason}`);
  }
}

function padEnd(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + " ".repeat(width - value.length);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}

export function formatTriageStatus(result: TriageStatusResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  // GH-1710: bd-canonical repos drop the reverse-orphan + drift lines (no GH
  // side to compare against) and rebuild the headline from bd-only buckets.
  if (result.canonical === "bd") {
    return formatTriageStatusBd(result);
  }

  // prx-3f1: reverse-orphans are NOT part of the remediation gate — bd-native
  // records (no external_ref) are the expected beads-first state, so they no
  // longer block the all-clear nor appear in the remediation headline.
  if (
    result.totalUntriaged === 0 &&
    result.totalDrift === 0 &&
    result.totalStale === 0 &&
    result.totalAxisConflicts === 0
  ) {
    const head = `All ${result.totalOpen} open issues in ${result.repo} are triaged with no pair drift, stale beads, or axis conflicts.`;
    return appendRateLimitBlock(head, result.rateLimit);
  }

  const lines: string[] = [];
  lines.push(
    `${result.totalUntriaged} untriaged · ${result.totalDrift} drift · ${result.totalStale} stale · ${result.totalAxisConflicts} axis-conflict in ${result.repo} (${result.totalOpen} open).`,
  );

  if (result.issues.length > 0) {
    lines.push("");
    lines.push(`Untriaged (${result.issues.length}):`);
    const idCol = Math.max(...result.issues.map((row) => `GH-${row.number}`.length), 5);
    const titleCol = 60;
    for (const row of result.issues) {
      const id = padEnd(`GH-${row.number}`, idCol);
      const title = padEnd(truncate(row.title, titleCol), titleCol);
      const missing = row.missing.join(", ");
      let line = `  ${id}  ${title}  [missing: ${missing}]`;
      if (row.unknownLabels.length > 0) {
        line += `  [unknown-labels: ${row.unknownLabels.join(", ")}]`;
      }
      if (row.weakSignals.length > 0) {
        line += `  [weak: ${row.weakSignals.join(", ")}]`;
      }
      lines.push(line);
    }
  }

  // prx-3f1: informational section only. Bead-native records (no GH mirror) are
  // the expected beads-first state, not a remediation bucket — they are not
  // counted in the headline and need no GH backfill.
  if (result.reverseOrphans.length > 0) {
    lines.push("");
    lines.push(
      `Bead-native, no GH mirror (${result.reverseOrphans.length}) — expected under beads-first, informational only:`,
    );
    const idCol = Math.max(...result.reverseOrphans.map((row) => row.beadsId.length), 8);
    const titleCol = 60;
    for (const row of result.reverseOrphans) {
      const id = padEnd(row.beadsId, idCol);
      const title = padEnd(truncate(row.title, titleCol), titleCol);
      const tag = `${row.issueType || "?"}/${row.priority}`;
      lines.push(`  ${id}  ${title}  [${tag}]`);
    }
  }

  if (result.drift.length > 0) {
    lines.push("");
    lines.push(`Drift (${result.drift.length}):`);
    for (const row of result.drift) {
      const fieldNames = Object.keys(row.fields).join(", ");
      lines.push(`  GH-${row.issueNumber} ↔ ${row.beadsId}  [${fieldNames}]`);
      for (const [name, pair] of Object.entries(row.fields)) {
        if (!pair) continue;
        const gh = pair.gh === null ? "—" : String(pair.gh);
        const bd = pair.bd === null ? "—" : String(pair.bd);
        lines.push(`      ${name}: gh=${JSON.stringify(gh)}  bd=${JSON.stringify(bd)}`);
      }
    }
  }

  if (result.stale.length > 0) {
    lines.push("");
    lines.push(`Stale (${result.stale.length}):`);
    const idCol = Math.max(...result.stale.map((row) => row.beadsId.length), 8);
    const titleCol = 60;
    for (const row of result.stale) {
      const id = padEnd(row.beadsId, idCol);
      const title = padEnd(truncate(row.title, titleCol), titleCol);
      const tag = `${row.issueType || "?"}/${row.priority}`;
      lines.push(
        `  ${id}  GH-${row.issueNumber}  ${title}  [${tag}]  → GH issue closed; bead still ${row.status}`,
      );
    }
  }

  if (result.axisConflicts.length > 0) {
    lines.push("");
    lines.push(`Axis Conflicts (${result.axisConflicts.length}):`);
    const idCol = Math.max(...result.axisConflicts.map((row) => `GH-${row.number}`.length), 5);
    const titleCol = 60;
    for (const row of result.axisConflicts) {
      const id = padEnd(`GH-${row.number}`, idCol);
      const title = padEnd(truncate(row.title, titleCol), titleCol);
      const detail = row.conflicts.map((c) => `${c.axis}: ${c.values.join(", ")}`).join("; ");
      lines.push(`  ${id}  ${title}  [${detail}]`);
    }
  }

  return appendRateLimitBlock(lines.join("\n"), result.rateLimit);
}

// GH-1710: plain-text formatter for canonical=bd. Drops the reverse-orphan
// and drift lines outright — bd-canonical repos have no GH-side queue to
// compare against, so those buckets are categorically inapplicable rather
// than incidentally zero.
function formatTriageStatusBd(result: TriageStatusResult): string {
  const untriaged = result.bdUntriaged ?? [];
  const stale = result.bdStale ?? [];

  if (untriaged.length === 0 && stale.length === 0) {
    const head = `All ${result.totalOpen} open beads in ${result.repo} (bd-canonical) are triaged with none stale.`;
    return appendRateLimitBlock(head, result.rateLimit);
  }

  const lines: string[] = [];
  lines.push(
    `${result.totalUntriaged} untriaged · ${result.totalStale} stale in ${result.repo} (${result.totalOpen} open, bd-canonical).`,
  );

  if (untriaged.length > 0) {
    lines.push("");
    lines.push(`Untriaged (${untriaged.length}):`);
    const idCol = Math.max(...untriaged.map((row) => row.beadsId.length), 8);
    const titleCol = 60;
    for (const row of untriaged) {
      const id = padEnd(row.beadsId, idCol);
      const title = padEnd(truncate(row.title, titleCol), titleCol);
      lines.push(`  ${id}  ${title}  [missing: ${row.missing.join(", ")}]`);
    }
  }

  if (stale.length > 0) {
    lines.push("");
    lines.push(`Stale (${stale.length}):`);
    const idCol = Math.max(...stale.map((row) => row.beadsId.length), 8);
    const titleCol = 60;
    for (const row of stale) {
      const id = padEnd(row.beadsId, idCol);
      const title = padEnd(truncate(row.title, titleCol), titleCol);
      lines.push(`  ${id}  ${title}  [${row.daysSince}d since ${row.lastTouched}]`);
    }
  }

  return appendRateLimitBlock(lines.join("\n"), result.rateLimit);
}

function appendRateLimitBlock(body: string, rateLimit: TriageStatusResult["rateLimit"]): string {
  if (!rateLimit) return body;
  const block = formatBudgetBlock(rateLimit.snapshots, rateLimit.estimate);
  return body.length > 0 ? `${body}\n\n${block}` : block;
}
