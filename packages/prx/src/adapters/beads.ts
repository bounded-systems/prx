/**
 * Beads domain adapter (GH-1645, GH-1658) — the third `DomainAdapter`
 * implementation (sibling to `src/adapters/github.ts` /
 * `src/adapters/notion.ts`). Per the GH-1500 authority ADR §7 (amended by
 * GH-1644): beads is canonical for every UoW; **pin-zero UoWs** (no external
 * domain pinned) address themselves through `BD-<short-id>` — the 8-hex tail
 * of the bd long-id.
 *
 * The adapter recognises two surface shapes:
 *
 *   1. **`BD-<8-hex>`** (GH-1645) — the local-workspace short form. Pin-zero
 *      UoWs resolved against the snapshot loaded from `cwd`. Returns the bare
 *      `[0-9a-f]{8}` tail as the external id.
 *   2. **`BD-<prefix>-<ts:13+>-<seq>-<hex8>`** (GH-1658) — the workspace-
 *      prefixed long-id form bd emits natively. The adapter consults the GH-
 *      1657 `bd_workspace_prefix` field on the covering `LocalRepo` (via
 *      `.prx/repos/index.json`); when the embedded prefix matches the local
 *      workspace the adapter returns the bare `<prefix>-<tail>` as the
 *      external id, when it does not the adapter throws
 *      `ForeignWorkspacePrefixError`. The future `repo_router` (GH-1659) is
 *      the only caller that branches on that typed error to drive cross-repo
 *      materialize — this PR only provides the refuse-on-foreign primitive.
 *
 * Field ownership (`ownedOnPull`) is empty by ADR §1 — bd is canonical for
 * every bd-side field, so there is nothing for a `pull` to overwrite. The
 * mirror verbs are no-ops:
 *
 *   - `pull(externalId)` — returns `{}`. bd is canonical; the bd source of
 *                          truth is itself.
 *   - `push(bd, fields)` — throws. Pin-zero records have nothing to project
 *                          externally; callers want `bd update`, not the
 *                          adapter push leg.
 *   - `resolve(extId)`   — exact 8-hex tail → bd record id. Linear scan over
 *                          the loaded snapshot (`endsWith("-" + key)`).
 *                          Multiple matches → `null` (ambiguous; caller
 *                          surfaces the error).
 */

import { localWorkspacePrefixForCwd } from "../pr-state/repos.ts";
// GH-1012: the aggregate bd read now comes from Front Desk (GH-canonical) via
// `loadAllBeadsViaCli` — same sync `() => BeadsRecord[]` contract the deleted
// `triage/triage.ts#loadAllBeads` used to provide.
import { loadAllBeadsViaCli as defaultLoadAllBeads } from "../triage/beads-daemon-loader.ts";
import { type BeadsRecord } from "../triage/triage.ts";
import {
  BD_LONG_ID_PATTERN,
  BD_SURFACE_ID_PATTERN,
  registerDomainAdapter,
  type AdapterIoOpts,
  type DomainAdapter,
  type DomainAdapterConfig,
  type DomainPushFields,
  type DomainPushResult,
  type EnumerateRange,
  type ExternalRecordRef,
  type ResolvedWorkUnitPatch,
} from "./domain-adapter.ts";

/**
 * Re-export of the canonical surface-id pattern for pin-zero UoWs (`BD-` +
 * the 8-hex tail of the bd long-id). The constant itself lives on
 * `domain-adapter.ts` next to `GH_SURFACE_ID_PATTERN` /
 * `NOTION_SURFACE_ID_PATTERN` so it can sit in `BASELINE_SURFACE_ID_PATTERNS`
 * — and so `src/machine/work_unit.ts`'s module-init snapshot of the
 * canonical-id union picks it up regardless of when this adapter's
 * side-effect registration runs. The adapter still owns dispatch.
 */
export const BD_SHORT_ID_PATTERN = BD_SURFACE_ID_PATTERN;

/**
 * Bd-side (no `BD-` prefix) long-id detection: the workspace-prefixed
 * timestamp form bd emits natively, e.g.
 * `ai-home-1777747201085-737-407f177f`. Workspace slug (lowercase, may
 * contain hyphens), 13+ digit millisecond timestamp, sequence number, then
 * the 8-hex tail. Used by `recognizesExternalId` for legacy `external_ref`
 * slots that carry a full bd long-id.
 */
const BD_LONG_ID_RE = /^[a-z][a-z0-9-]*-\d{13,}-\d+-[0-9a-f]{8}$/i;

/**
 * GH-1658: split the *surface* form (with the `BD-` prefix) into capture
 * groups `(prefix, tail)`. `prefix` is the workspace slug; `tail` is
 * `<ts>-<seq>-<hex8>`. The bd-side external id the rest of the adapter
 * exchanges is the bare `<prefix>-<tail>` (no `BD-`), matching `record.id`
 * in the bd snapshot.
 */
const BD_SURFACE_LONG_ID_RE = /^BD-([a-z][a-z0-9-]*)-(\d{13,}-\d+-[0-9a-f]{8})$/;

/** Trailing 8-hex tail extractor, used for the `endsWith` scan in `resolveFromBeads`. */
const BD_HEX8_TAIL_RE = /-([0-9a-f]{8})$/i;

// ADR §1: bd is canonical for every bd-side field. There is nothing the
// adapter pulls from an external system, so the field-ownership list is
// empty. (Editing this list MUST be paired with a doc edit — same byte-pin
// rule as `GH_OWNED_ON_PULL` / `NOTION_OWNED_ON_PULL`.)
export const BD_OWNED_ON_PULL = [] as const;

export class BdDomainAdapterError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "BdDomainAdapterError";
    this.exitCode = exitCode;
  }
}

/**
 * GH-1658: thrown when `surfaceIdToExternalId` receives a `BD-<prefix>-<tail>`
 * long-id whose embedded workspace prefix does not match the prefix the
 * covering `LocalRepo` advertises in `.prx/repos/index.json`. The future
 * `repo_router` (GH-1659) is the only consumer that branches on this typed
 * error to drive `prx repo materialize`; callers that catch
 * `Error`/`BdDomainAdapterError` will see this surface as a generic adapter
 * failure (`exitCode = 2`).
 */
export class ForeignWorkspacePrefixError extends Error {
  readonly surfaceId: string;
  readonly embeddedPrefix: string;
  readonly localPrefix: string | null;
  readonly exitCode = 2;
  constructor(opts: {
    surfaceId: string;
    embeddedPrefix: string;
    localPrefix: string | null;
  }) {
    const where = opts.localPrefix ? `"${opts.localPrefix}"` : "<unknown>";
    super(
      `bd adapter: surface id ${opts.surfaceId} embeds workspace ` +
        `prefix "${opts.embeddedPrefix}" but cwd workspace is ${where}. ` +
        `Cross-repo routing for foreign prefixes lives in repo_router ` +
        `(GH-1659); see docs/spikes/GH-1646-cross-repo-bd-routing.md.`,
    );
    this.name = "ForeignWorkspacePrefixError";
    this.surfaceId = opts.surfaceId;
    this.embeddedPrefix = opts.embeddedPrefix;
    this.localPrefix = opts.localPrefix;
  }
}

export type BdDomainAdapterDeps = {
  /** Loader for the full bd record set. Defaults to `loadAllBeadsViaCli` (Front Desk). */
  loadAllBeads?: typeof defaultLoadAllBeads;
  /** cwd source. Defaults to `process.cwd`. */
  cwd?: () => string;
  /**
   * GH-1658: local BD workspace prefix lookup. Defaults to
   * `localWorkspacePrefixForCwd` (reads `.prx/repos/index.json`). Returns
   * `null` when the cwd is not covered by any `LocalRepo` or the covering
   * entry is pre-GH-1657 (field absent). Pure index-read; no subprocess at
   * routing time.
   */
  localWorkspacePrefix?: (cwd: string) => string | null;
};

export class BdDomainAdapter implements DomainAdapter {
  readonly config: DomainAdapterConfig;

  private readonly deps: Required<Pick<BdDomainAdapterDeps, "cwd" | "localWorkspacePrefix">> &
    BdDomainAdapterDeps;

  constructor(deps: BdDomainAdapterDeps = {}) {
    this.config = {
      domain: "bd",
      surfaceIdPattern: BD_SURFACE_ID_PATTERN,
      externalIdShape: "bd-long-id",
      ownedOnPull: BD_OWNED_ON_PULL,
    };
    this.deps = {
      ...deps,
      cwd: deps.cwd ?? (() => process.cwd()),
      localWorkspacePrefix:
        deps.localWorkspacePrefix ?? ((cwd: string) => localWorkspacePrefixForCwd(cwd)),
    };
  }

  private loadBeads(): BeadsRecord[] {
    const loader = this.deps.loadAllBeads ?? defaultLoadAllBeads;
    return loader();
  }

  matchesSurfaceId(id: string): boolean {
    const trimmed = id.trim();
    if (BD_SURFACE_ID_PATTERN.test(trimmed.toUpperCase())) return true;
    // GH-1658: long-id arm. Lowercase-only (the bd workspace prefix is
    // structurally lowercase per WORKSPACE_PREFIX_PATTERN).
    if (BD_LONG_ID_PATTERN.test(trimmed)) return true;
    // GH-1766: bare workspace-long-id arm — recognise the bd-native form
    // (`<workspace>-<rest>`) when the workspace prefix matches the cwd repo's
    // bd_workspace_prefix. Used by `prx plan session` so operators can paste
    // the form `bd ready --json` emits directly.
    return this.bareWorkspaceLongIdMatchesLocal(trimmed);
  }

  /**
   * GH-1766: recognise `<bd_workspace_prefix>-<rest>` against the cwd repo's
   * registered bd workspace prefix. Returns false when the cwd is not covered
   * by a `LocalRepo` carrying a prefix, when the input is uppercase
   * `BD-`-prefixed (those go through the surface-id arms above), and when the
   * prefix does not match. The trailing-shape check matches both
   * `<ts>-<seq>-<hex8>` (bd long-id tail) and arbitrary semantic-id tails
   * (`pin.9.4.2`); narrower validation lives in `surfaceIdToExternalId`.
   */
  private bareWorkspaceLongIdMatchesLocal(trimmed: string): boolean {
    if (trimmed.length === 0) return false;
    // Already covered by the upper arms.
    if (trimmed.toUpperCase().startsWith("BD-")) return false;
    const cwd = this.deps.cwd();
    const localPrefix = this.deps.localWorkspacePrefix(cwd);
    if (!localPrefix) return false;
    if (!trimmed.toLowerCase().startsWith(`${localPrefix.toLowerCase()}-`)) return false;
    return trimmed.length > localPrefix.length + 1;
  }

  /**
   * Widens beyond `matchesSurfaceId`: legacy `external_ref` / metadata slots
   * may carry a full bd long-id, so the adapter recognises that form too.
   * The 8-hex short tail is also accepted.
   */
  recognizesExternalId(externalId: string): boolean {
    if (typeof externalId !== "string") return false;
    const trimmed = externalId.trim();
    if (trimmed.length === 0) return false;
    if (/^[0-9a-f]{8}$/i.test(trimmed)) return true;
    return BD_LONG_ID_RE.test(trimmed);
  }

  surfaceIdToExternalId(id: string, repoCtx?: { repo?: string; cwd?: string }): string {
    const trimmed = id.trim();
    const upper = trimmed.toUpperCase();

    if (BD_SURFACE_ID_PATTERN.test(upper)) {
      // Strip `BD-` prefix → lowercase the 8-hex → that is the bd-side key
      // we exchange (the `endsWith("-<hex8>")` lookup tail).
      return upper.slice(3).toLowerCase();
    }

    const long = trimmed.match(BD_SURFACE_LONG_ID_RE);
    if (long) {
      const embeddedPrefix = long[1]!;
      const tail = long[2]!;
      const cwd = repoCtx?.cwd ?? this.deps.cwd();
      const localPrefix = this.deps.localWorkspacePrefix(cwd);
      if (localPrefix === null || embeddedPrefix !== localPrefix) {
        throw new ForeignWorkspacePrefixError({
          surfaceId: trimmed,
          embeddedPrefix,
          localPrefix,
        });
      }
      return `${embeddedPrefix}-${tail}`;
    }

    // GH-1766: bare workspace-long-id arm. `bd ready --json` and `bd list
    // --json` emit ids in this shape directly. The trimmed string must start
    // with the cwd repo's registered bd workspace prefix; otherwise the
    // adapter throws (a foreign prefix is operator error, not silent route).
    if (!trimmed.toUpperCase().startsWith("BD-")) {
      const cwd = repoCtx?.cwd ?? this.deps.cwd();
      const localPrefix = this.deps.localWorkspacePrefix(cwd);
      if (localPrefix && trimmed.toLowerCase().startsWith(`${localPrefix.toLowerCase()}-`)) {
        return trimmed;
      }
    }

    throw new BdDomainAdapterError(`bd adapter: not a BD- surface id (short or long): ${id}`);
  }

  async pull(_externalId: string, _opts?: AdapterIoOpts): Promise<ResolvedWorkUnitPatch> {
    return {};
  }

  async push(
    _bd: BeadsRecord,
    _fields: DomainPushFields,
    _opts?: AdapterIoOpts,
  ): Promise<DomainPushResult> {
    throw new BdDomainAdapterError(
      "bd adapter: push is a no-op — bd is canonical for pin-zero UoWs; use `bd update` directly",
    );
  }

  /**
   * GH-1469 — not implemented for the bd domain. `prx sync backfill` heals
   * external records the forward-only sync cursor skipped; bd *is* the
   * canonical store, so there is no external range to enumerate against it.
   * Throws a typed error so the interface stays total.
   */
  async enumerate(_range: EnumerateRange, _opts?: AdapterIoOpts): Promise<ExternalRecordRef[]> {
    throw new BdDomainAdapterError(
      "bd adapter: enumerate (prx sync backfill) is not implemented for the bd domain",
    );
  }

  async resolve(externalId: string, _opts?: AdapterIoOpts): Promise<string | null> {
    return this.resolveFromBeads(externalId, this.loadBeads());
  }

  resolveFromBeads(externalId: string, beads: BeadsRecord[]): string | null {
    if (typeof externalId !== "string") return null;
    const trimmed = externalId.trim();
    if (trimmed.length === 0) return null;
    // GH-1766: exact-id fallback for semantic-id workspaces. bd records whose
    // long-id ends in a non-hex tail (e.g. `pin.9.4.2`) cannot be located by
    // the hex8-suffix scan; an exact match against `record.id` is the only
    // safe lookup. Runs first so an exact hit short-circuits the suffix scan.
    for (const record of beads) {
      if (typeof record.id !== "string") continue;
      if (record.id === trimmed) return record.id;
    }
    // Accept either the bare 8-hex tail or a full bd long-id; in both cases
    // the lookup key is the lowercase 8-hex suffix.
    let key: string | null = null;
    if (/^[0-9a-f]{8}$/i.test(trimmed)) {
      key = trimmed.toLowerCase();
    } else {
      const tail = trimmed.match(BD_HEX8_TAIL_RE);
      if (tail) key = tail[1]!.toLowerCase();
    }
    if (!key) return null;
    const suffix = `-${key}`;
    let hit: string | null = null;
    for (const record of beads) {
      if (typeof record.id !== "string") continue;
      if (!record.id.toLowerCase().endsWith(suffix)) continue;
      if (hit !== null) return null;
      hit = record.id;
    }
    return hit;
  }
}

/** The default bd adapter singleton, registered on import. */
export const beadsDomainAdapter = registerDomainAdapter(new BdDomainAdapter());
