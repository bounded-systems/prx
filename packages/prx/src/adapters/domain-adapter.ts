/**
 * Domain-adapter interface — the typed seam where an external work-unit DB
 * (GitHub, Notion, Jira, …) plugs in as an *opt-in mirror target* (GH-1536).
 *
 * Per the GH-1500 authority ADR (`docs/spikes/GH-1500-authority.md`): beads is
 * canonical for every unit of work; external DBs are mirror targets per UoW.
 * Each adapter declares:
 *   - a Zod-validated `config` (domain prefix, surface-id pattern, external-id
 *     shape, and an `ownedOnPull` field-ownership list = the ADR §2 directional
 *     matrix column for that domain), and
 *   - `pull` / `push` / `resolve` verbs.
 *
 * This module is intentionally dependency-light (zod + type-only imports) so it
 * can sit *below* `src/machine/work_unit.ts` in the import graph —
 * `canonicalWorkUnitIdPattern` is now derived from `combinedCanonicalIdPattern`
 * instead of a hardcoded `GH-\d+|NOTION-…` literal. The concrete adapters
 * (`src/adapters/github.ts`, future Notion/Jira) self-register on import.
 */

import { z } from "zod";

import type { BeadsRecord } from "../triage/triage.ts";

// ---------------------------------------------------------------------------
// Default surface-id patterns
//
// These are the *baseline* canonical-id shapes prx recognises even before a
// concrete adapter has been imported (so e.g. `NOTION-…` keeps resolving as a
// canonical id while the Notion adapter is still just a registry slot —
// GH-1538+). The constants live here (not on the adapter modules) because
// `src/machine/work_unit.ts` snapshots the union once at module-init via
// `canonicalWorkUnitIdPattern = combinedCanonicalIdPattern()`; adapter
// side-effect registration that happens after that snapshot would otherwise
// be invisible to the cached pattern.
//
// `BD_SURFACE_ID_PATTERN` (GH-1645) joins the baseline so `BD-<8-hex>` is
// recognised as canonical even in import paths that pull
// `src/machine/work_unit.ts` before the adapter barrel
// (`src/adapters/index.ts`) has loaded — same shape NOTION has today.
//
// `BD_LONG_ID_PATTERN` (GH-1658) joins the baseline as a second BD arm: the
// workspace-prefixed long-id surface (`BD-<prefix>-<ts:13+>-<seq>-<hex8>`)
// the cross-repo router (GH-1659) projects to a `(repo, externalId)` pair.
// Both arms are recognised as canonical even before the adapter registers;
// `BdDomainAdapter.matchesSurfaceId` ORs them so dispatch routes both.
// ---------------------------------------------------------------------------

export const GH_SURFACE_ID_PATTERN = /^GH-\d+$/;
export const NOTION_SURFACE_ID_PATTERN = /^NOTION-([0-9a-fA-F]{32}|\d+)$/;
export const BD_SURFACE_ID_PATTERN = /^BD-[0-9A-F]{8}$/;
export const BD_LONG_ID_PATTERN = /^BD-[a-z][a-z0-9-]*-\d{13,}-\d+-[0-9a-f]{8}$/;

const BASELINE_SURFACE_ID_PATTERNS: readonly RegExp[] = [
  GH_SURFACE_ID_PATTERN,
  NOTION_SURFACE_ID_PATTERN,
  BD_SURFACE_ID_PATTERN,
  BD_LONG_ID_PATTERN,
];

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

/**
 * Shape of the external id a domain hands back / takes in:
 *   - `issue-url`   — GitHub issue URL (`https://github.com/o/r/issues/N`)
 *   - `page-uuid`   — Notion page UUID
 *   - `key-n`       — Jira-style `PROJ-123` key
 *   - `bd-long-id`  — bd workspace-prefixed long id (`<prefix>-<ts>-<seq>-<hex>`)
 */
export const externalIdShapes = ["issue-url", "page-uuid", "key-n", "bd-long-id"] as const;
export type ExternalIdShape = (typeof externalIdShapes)[number];

const regexFromStringOrRegExp = z
  .union([z.instanceof(RegExp), z.string()])
  .transform((value, ctx) => {
    if (value instanceof RegExp) return value;
    try {
      return new RegExp(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `surfaceIdPattern is not a valid regex: ${value} (${
          error instanceof Error ? error.message : String(error)
        })`,
      });
      return z.NEVER;
    }
  });

export const domainAdapterConfigSchema = z.object({
  /** Lowercase domain prefix, e.g. `"gh"` / `"notion"` / `"jira"`. */
  domain: z.string().regex(/^[a-z][a-z0-9-]*$/, 'domain must be a lowercase prefix (e.g. "gh")'),
  /** Anchored regex that recognises this domain's canonical surface ids. */
  surfaceIdPattern: regexFromStringOrRegExp,
  /** Shape of the external id `pull`/`push`/`resolve` exchange. */
  externalIdShape: z.enum(externalIdShapes),
  /**
   * Field-ownership declaration: `BeadsRecord`-keyed names this domain *owns
   * on pull* — i.e. the external DB is authoritative for these and a pull
   * overwrites the local bd value. The ADR §2 directional matrix column for
   * this domain. (`push` never reads these back.)
   */
  ownedOnPull: z.array(z.string()).readonly(),
});

export type DomainAdapterConfigInput = z.input<typeof domainAdapterConfigSchema>;
export type DomainAdapterConfig = z.output<typeof domainAdapterConfigSchema>;

// ---------------------------------------------------------------------------
// Adapter I/O types
// ---------------------------------------------------------------------------

/**
 * Minimal command-runner shape adapters thread through for `gh`/CLI I/O.
 * Structurally compatible with `CommandRunner` in `src/pr-state/github.ts` —
 * declared locally to keep this module out of that import cycle.
 */
export type AdapterCommandRunner = (
  cmd: string[],
  options?: { cwd?: string; check?: boolean; env?: NodeJS.ProcessEnv },
) => { stdout: string; stderr: string; status: number };

export type AdapterIoOpts = {
  /** Working directory for spawned commands. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Override the command runner (rate-limit-gated by default). */
  runner?: AdapterCommandRunner;
  /**
   * GH-2382 — when true, a reconcile computes the live diff but issues no
   * external writes (the `--dry-run` preview seam). Adapters that support it
   * return the planned change with no side effects; adapters that don't may
   * ignore it. Honored by `GhDomainAdapter.reconcileLinked`.
   */
  dryRun?: boolean;
};

/**
 * The `Partial<BeadsRecord>`-shaped patch a `pull` returns: only the fields the
 * adapter `ownedOnPull`. `assignees` / `milestone` are pull-only — they are not
 * persisted on `BeadsRecord` today (GH-1538 widens the schema), so they live on
 * the patch shape directly.
 */
export type ResolvedWorkUnitPatch = {
  externalIssueNumber?: number | null;
  status?: string;
  assignees?: readonly string[];
  milestone?: string | null;
};

/** bd-authoritative fields a `push` projects onto the external record. */
export type DomainPushFields = {
  title?: string;
  body?: string;
  /**
   * GH-2382 — the bd-authoritative *axis-label* set to project. Adapters treat
   * this as the desired managed-axis state and emit the lossless add/remove
   * swap against the live external labels (a priority bump strips the stale
   * rung; foreign labels and GH-only markers are preserved). `undefined`
   * preserves push's field-by-field idempotency (no read, no edit). Before
   * GH-2382 this was add-only.
   */
  labels?: readonly string[];
  /**
   * GH-1874 — bd-authoritative assignee set, projected through the bd→GH
   * mirror. bd's column is singular (`BeadsRecord.assignee`); callers pass
   * `[bd.assignee]` or `[]` for clear. Adapters compute the minimal diff
   * against the external state to emit add/remove deltas. `undefined`
   * preserves push's field-by-field idempotency (no-op).
   */
  assignees?: readonly string[];
  /**
   * GH-2382 — bd-authoritative open/closed state, projected bd→external.
   * `undefined` preserves field-by-field idempotency (no read, no write).
   * The projection is strictly bd→external (I-DS-PRIO / I-PROJ1): the live
   * read is reconciliation-only and never feeds a bd-side write. Note the
   * `prx beads publish` and `prx beads sync` callers deliberately do *not*
   * pass this — status stays owned by the merge-close / `bulkClose` paths to
   * avoid a pull-vs-push close/reopen conflict; the field is honored here so
   * an explicit caller (or a future domain) can project it losslessly.
   */
  status?: "open" | "closed";
};

export type DomainPushResult = {
  /** The external id (e.g. issue URL) the bd record is now mirrored to. */
  externalId: string;
  /** True when this call created the external record; false when it edited an existing one. */
  created: boolean;
  /**
   * GH-2382 — true when this call actually touched the external record (a
   * create, a field edit, or a status reopen/close); false when every
   * projected field already matched and no write was issued. Lets the sync
   * push leg and `prx beads publish` report a real `reconciled`-vs-`noop`
   * outcome instead of assuming every push edited.
   */
  edited: boolean;
};

// ---------------------------------------------------------------------------
// Enumeration (GH-1469 — the `prx sync backfill` discovery seam)
// ---------------------------------------------------------------------------

/**
 * A range of external records to enumerate, by the domain's natural ordinal.
 * For `gh` this is the GitHub issue-number range `[from, to]` (inclusive).
 */
export type EnumerateRange = {
  from: number;
  to: number;
};

/**
 * One external record `enumerate()` hands back — the minimal shape `prx sync
 * backfill` needs to resolve each record against the `(domain, external_id)`
 * map and (when unmatched) mirror it through the canonical single-record path.
 *
 *   - `externalId` — the external-id shape this domain exchanges (for `gh`, the
 *     issue URL). Fed to `resolveFromBeads` / the mirror path.
 *   - `surfaceId`  — the canonical surface id (for `gh`, `GH-<n>`).
 */
export type ExternalRecordRef = {
  externalId: string;
  surfaceId: string;
  number?: number;
  state?: "open" | "closed";
};

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface DomainAdapter {
  readonly config: DomainAdapterConfig;

  /**
   * Does `id` look like one of this domain's canonical surface ids?
   *
   * **Cheap-only contract (GH-2015):** the CLI canonical-id gate
   * (`parseCanonicalWorkUnitId`) falls through to `adapterForCanonicalId` —
   * which iterates `matchesSurfaceId` across every registered adapter — on
   * every user-typed id. Implementations MUST be synchronous, MUST NOT spawn
   * subprocesses or hit the network, and MAY read only cached / local-disk
   * state. The upper bound is BD's bare-workspace arm, which reads the
   * cached `.prx/repos/index.json` to resolve `bd_workspace_prefix(cwd)`.
   */
  matchesSurfaceId(id: string): boolean;

  /**
   * Does `externalId` look like one of this domain's external-id shapes?
   * Each domain decides its own external-id shape — `BaseDomainAdapter` does
   * not provide a default. Used by `loadAllBeads` to populate the
   * `BeadsRecord.externalRefs.<domain>` slot from the legacy `external_ref`
   * single-pin (GH-1538).
   */
  recognizesExternalId(externalId: string): boolean;

  /**
   * Turn a canonical surface id (e.g. `GH-456`) into the external id the other
   * verbs exchange (e.g. an issue URL). `repoCtx` supplies the owner/repo when
   * the surface id alone is not enough (GitHub issue numbers are repo-scoped).
   */
  surfaceIdToExternalId(id: string, repoCtx?: { repo?: string; cwd?: string }): string;

  /**
   * Read the external record and return the `ownedOnPull` fields as a patch.
   *
   * **Cost contract (GH-2095, invariant I-DS3):** MUST be cheap — one gated
   * read against the external API (or a cached lookup), idempotent, no
   * side effects. The `prx beads sync` orchestrator runs `pull()` once per
   * pinned pair per tick — unbounded by `--limit` — so the close-apply step
   * (I-DS2) sees every pair whose external record went CLOSED. `--limit` is
   * a write-side budget on `push()`, never a read-side cap on `pull()`. This
   * contract is the generalisation knob across every `DomainAdapter`: holds
   * for `gh` (GH-2095 motivating case) and for any future `notion` / `jira`
   * adapter. If `pull()` ever needs to be expensive enough that running it
   * over the full pinned set becomes infeasible, raise it as a contract
   * change — not as a silent slice in the orchestrator.
   */
  pull(externalId: string, opts?: AdapterIoOpts): Promise<ResolvedWorkUnitPatch>;

  /**
   * Write the bd-authoritative `fields` onto the external record. Create the
   * record if `bd.externalRef` is unset (idempotent — dedup-checked, never
   * duplicates; writes the new external id back to the bd record). Never reads
   * bd-authoritative fields back from the external DB.
   */
  push(bd: BeadsRecord, fields: DomainPushFields, opts?: AdapterIoOpts): Promise<DomainPushResult>;

  /**
   * Enumerate the external records over `range` (GH-1469 — the discovery seam
   * `prx sync backfill` walks). Returns one `ExternalRecordRef` per external
   * record in range, in no guaranteed order. Used to recover records the
   * forward-only sync cursor skipped without ever importing.
   *
   * **Cost contract (consistent with `pull()`):** implementations make gated
   * reads only (the GH-1141 rate-limit gate / a cached lookup); the *runtime*
   * budgets the per-record mirror loop that consumes the result, not this
   * method. `enumerate()` is read-only and side-effect-free — it never writes
   * bd, never writes the external DB, and never advances any fetch watermark
   * or sync cursor (I-BF3).
   */
  enumerate(range: EnumerateRange, opts?: AdapterIoOpts): Promise<ExternalRecordRef[]>;

  /** Map an external id to the canonical bd short-id, or `null` when unmirrored. */
  resolve(externalId: string, opts?: AdapterIoOpts): Promise<string | null>;

  /**
   * Sync sibling of `resolve` for callers that have already loaded the bd
   * snapshot. Same dispatch contract: returns the bd short-id, or `null` when
   * no record is pinned to this `externalId` in this domain. Consumed by
   * `resolveUoW` (GH-1538) — pure dispatch, never short-id prefix matching.
   */
  resolveFromBeads(externalId: string, beads: BeadsRecord[]): string | null;

  /**
   * Batched close-apply for pairs whose pull leg flagged `needsClose` this
   * tick. Adapters whose native close-apply dispatches repo-wide (GitHub's
   * `bd github sync --pull-only --prefer-github`) may ignore `beadIds`;
   * adapters without a repo-wide verb loop the provided ids. Optional — the
   * run loop falls back to the GH-only `runBdGithubSyncPullOnly` shim when
   * an adapter omits it.
   */
  bulkClose?(opts: {
    cwd: string;
    /**
     * Bead ids the per-pair pull flagged as needsClose this tick. Adapters that
     * dispatch repo-wide may ignore this; loop-based adapters use it directly.
     */
    beadIds: readonly string[];
  }): { exitCode: number; stdout: string; stderr: string };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, DomainAdapter>();

/**
 * Register (or replace) a domain adapter. Validates + freezes the adapter's
 * `config` through `domainAdapterConfigSchema`; throws on a malformed config.
 * Registering the same `domain` twice replaces the prior entry — this is how a
 * concrete adapter (`src/adapters/github.ts`) supersedes a placeholder.
 */
export function registerDomainAdapter(adapter: DomainAdapter): DomainAdapter {
  const parsed = domainAdapterConfigSchema.parse(adapter.config);
  // Re-pin the validated+frozen config onto the adapter so downstream callers
  // see a stable, immutable shape regardless of how the adapter built it.
  Object.defineProperty(adapter, "config", {
    value: Object.freeze(parsed),
    writable: false,
    enumerable: true,
    configurable: true,
  });
  registry.set(parsed.domain, adapter);
  return adapter;
}

/** Test-only: drop a registered adapter (or clear all). */
export function __unregisterDomainAdapterForTesting(domain?: string): void {
  if (domain === undefined) {
    registry.clear();
    return;
  }
  registry.delete(domain);
}

export function adapterForDomain(domain: string): DomainAdapter | null {
  return registry.get(domain) ?? null;
}

/** Find the registered adapter whose `surfaceIdPattern` matches `id`. */
export function adapterForCanonicalId(id: string): DomainAdapter | null {
  for (const adapter of registry.values()) {
    if (adapter.matchesSurfaceId(id)) return adapter;
  }
  return null;
}

export function registeredDomains(): string[] {
  return [...registry.keys()];
}

function unanchor(source: string): string {
  return source.replace(/^\^/, "").replace(/\$$/, "");
}

/**
 * The union of every recognised canonical surface-id pattern: the baseline
 * GH/Notion shapes plus any extra registered adapter patterns. Consumed by
 * `src/machine/work_unit.ts` so canonical-id recognition is driven by the
 * adapter registry rather than a hardcoded literal. With the prx-default
 * adapter set imported (GitHub + Notion + Beads — see `src/adapters/index.ts`)
 * this resolves to
 * `^(GH-\d+|NOTION-([0-9a-fA-F]{32}|\d+)|BD-[0-9A-F]{8}|BD-[a-z][a-z0-9-]*-\d{13,}-\d+-[0-9a-f]{8})$`,
 * the literal `loadIdentityConfig`'s `isDefault` check compares against
 * byte-for-byte. The `BD-<8-hex>` arm is the GH-1645 pin-zero canonical
 * surface; the `BD-<prefix>-<ts>-<seq>-<hex8>` arm is the GH-1658 workspace-
 * prefixed long-id surface routed by `repo_router` (GH-1659). Both are
 * contributed by `src/adapters/beads.ts`.
 */
export function combinedCanonicalIdPattern(): RegExp {
  const seen = new Set<string>();
  const alternatives: string[] = [];
  const add = (pattern: RegExp): void => {
    const body = unanchor(pattern.source);
    if (seen.has(body)) return;
    seen.add(body);
    alternatives.push(body);
  };
  for (const pattern of BASELINE_SURFACE_ID_PATTERNS) add(pattern);
  for (const adapter of registry.values()) add(adapter.config.surfaceIdPattern);
  return new RegExp(`^(${alternatives.join("|")})$`);
}

// ---------------------------------------------------------------------------
// Identity-config overlay
// ---------------------------------------------------------------------------

/**
 * Per-repo `[identity]` overlay (`canonical_id_pattern`, `[identity.notion]`)
 * from `loadIdentityConfig`. When a repo pins a custom `canonical_id_pattern`,
 * that wins outright — the registry-derived union is only used for the default
 * repo. Kept as a free function (not auto-applied) so `domain-adapter.ts` need
 * not import `src/pr-state/github.ts`.
 */
export type IdentityOverlay = {
  canonicalIdPattern: RegExp;
  isDefault: boolean;
};

export function canonicalIdPatternForIdentity(identity: IdentityOverlay): RegExp {
  return identity.isDefault ? combinedCanonicalIdPattern() : identity.canonicalIdPattern;
}

// ---------------------------------------------------------------------------
// Base helper for concrete adapters
// ---------------------------------------------------------------------------

/**
 * Optional base class concrete adapters can extend for the boilerplate
 * `matchesSurfaceId` implementation. (The `config` here is the *unvalidated*
 * input; `registerDomainAdapter` re-pins the validated/frozen version.)
 */
export abstract class BaseDomainAdapter implements DomainAdapter {
  readonly config: DomainAdapterConfig;

  protected constructor(config: DomainAdapterConfigInput) {
    this.config = domainAdapterConfigSchema.parse(config);
  }

  matchesSurfaceId(id: string): boolean {
    return this.config.surfaceIdPattern.test(id.trim());
  }

  abstract recognizesExternalId(externalId: string): boolean;
  abstract surfaceIdToExternalId(id: string, repoCtx?: { repo?: string; cwd?: string }): string;
  abstract pull(externalId: string, opts?: AdapterIoOpts): Promise<ResolvedWorkUnitPatch>;
  abstract push(
    bd: BeadsRecord,
    fields: DomainPushFields,
    opts?: AdapterIoOpts,
  ): Promise<DomainPushResult>;
  abstract enumerate(range: EnumerateRange, opts?: AdapterIoOpts): Promise<ExternalRecordRef[]>;
  abstract resolve(externalId: string, opts?: AdapterIoOpts): Promise<string | null>;
  abstract resolveFromBeads(externalId: string, beads: BeadsRecord[]): string | null;
}
