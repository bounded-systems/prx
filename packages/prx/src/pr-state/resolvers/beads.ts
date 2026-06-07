/**
 * GH-1766: BeadsResolver — hydrate path for `canonical=bd` plan/implement
 * sessions. Sibling of {@link GithubResolver} (which calls `gh issue view`
 * via `validateGitHubIssue`). The bd resolver fetches via `bd show --json`
 * and maps the bd record fields onto the shared {@link ResolvedWorkUnit}
 * shape so the parity-chain `probeNonGhResolver` arm can short-circuit a
 * GH-keyed hydrate against a bd-canonical repo.
 *
 * Input forms — `BeadsResolver.fetch` accepts any of:
 *
 *   - `BD-<8hex>` short surface id,
 *   - `BD-<workspace>-<ts>-<seq>-<hex8>` long surface id, or
 *   - a bare bd-native long-id (`<workspace>-…`).
 *
 * The resolver normalises through {@link BdDomainAdapter} (`resolveFromBeads`
 * + `surfaceIdToExternalId`) so all three forms resolve to the same bd
 * record. The returned `id` field carries the caller-supplied
 * `canonicalId` unchanged — `primePlanSession` normalises to `BD-<8hex>`
 * upstream so the worktree/branch/parity-chain row id stays uniform.
 */

import { beadsDomainAdapter, BdDomainAdapterError, ForeignWorkspacePrefixError } from "../../adapters/beads.ts";
import type { BeadsRecord } from "../../triage/triage.ts";
// GH-296: read through beadsd (one true source). The daemon serves one
// workspace = one repo (multi-tenant is rejected as a security risk), so the
// resolver's `cwd` is vestigial — it routes to the single per-repo daemon.
import { showBeadViaDaemon, loadAllBeadsViaDaemon } from "../../beadsd/reads.ts";
import { defaultRunner, type CommandRunner } from "../github.ts";
import type { ResolvedWorkUnit, WorkUnitResolver } from "./types.ts";

export type BeadsResolverDeps = {
  /** Targeted daemon read (`bd show <id>`). Defaults to {@link showBeadViaDaemon}. */
  showBead?: (id: string) => Promise<BeadsRecord | null>;
  /** Snapshot loader for the BD-<8hex>/external-ref scans. Defaults to {@link loadAllBeadsViaDaemon}. */
  loadBeads?: () => Promise<BeadsRecord[]>;
  /**
   * GH-852: domain prefix for the external-ref lookup arm. When set, non-BD
   * canonical ids (e.g. `PROJ-5743`) resolve by scanning the snapshot for
   * a record whose `externalRefs[externalRefPrefix]` equals
   * `<externalRefPrefix>-<lowercased numeric suffix>`. Threaded from
   * `BeadsSourceConfig.externalRefPrefix` via `resolverForSource`.
   */
  externalRefPrefix?: string | null;
};

export class BeadsResolverError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "BeadsResolverError";
    this.exitCode = exitCode;
  }
}

export class BeadsResolver implements WorkUnitResolver {
  readonly name = "beads" as const;

  private readonly showBead: (id: string) => Promise<BeadsRecord | null>;
  private readonly loadBeads: () => Promise<BeadsRecord[]>;
  private readonly externalRefPrefix: string | null;

  constructor(
    private readonly cwd: string,
    deps: BeadsResolverDeps = {},
  ) {
    this.showBead = deps.showBead ?? showBeadViaDaemon;
    this.loadBeads = deps.loadBeads ?? loadAllBeadsViaDaemon;
    this.externalRefPrefix = deps.externalRefPrefix ?? null;
  }

  async fetch(
    canonicalId: string,
    opts?: { runner?: CommandRunner },
  ): Promise<ResolvedWorkUnit> {
    const _runner = opts?.runner ?? defaultRunner;
    // GH-852: BD-* / bare-workspace-long-id surface ids go through the
    // existing snapshot scan; non-BD canonical ids (e.g. PROJ-5743)
    // route through the external_ref arm when the source is configured
    // with an external_ref_prefix.
    const longId = beadsDomainAdapter.matchesSurfaceId(canonicalId)
      ? await this.toBdLongId(canonicalId)
      : await this.resolveByExternalRef(canonicalId);
    let record: BeadsRecord | null;
    try {
      record = await this.showBead(longId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new BeadsResolverError(`bd show ${longId}: ${detail}`);
    }
    if (!record) {
      throw new BeadsResolverError(`bd show ${longId}: record not found`);
    }
    const state =
      record.status === "closed" || record.status === "resolved"
        ? "closed"
        : "open";
    return {
      id: canonicalId,
      title: record.title,
      body: record.description.length > 0 ? record.description : null,
      state,
      url: null,
      source: "beads",
    };
  }

  /**
   * GH-1766: input-form normalisation. Resolves a surface id (any of the
   * three accepted shapes) to the bd long-id `bd show` expects on the CLI.
   * Public so `primePlanSession`'s canonical=bd fork can derive the long-id
   * for `runBdUpdateClaim` without re-walking the snapshot.
   *
   *   - `BD-<8hex>` → suffix scan via `resolveFromBeads`.
   *   - `BD-<workspace>-…` → `surfaceIdToExternalId` (foreign-prefix error
   *     bubbles up unchanged so the caller can route cross-repo).
   *   - bare bd-native long-id → exact-match (passes through unchanged when
   *     it already looks like the bd-side id; `resolveFromBeads` validates
   *     it exists via the exact-id fallback added in this PR).
   */
  async toBdLongId(canonicalId: string): Promise<string> {
    const trimmed = canonicalId.trim();
    if (trimmed.length === 0) {
      throw new BeadsResolverError("bd id must not be empty");
    }
    const upper = trimmed.toUpperCase();

    if (/^BD-[0-9A-F]{8}$/.test(upper)) {
      const beads = await this.loadBeads();
      const hit = beadsDomainAdapter.resolveFromBeads(upper.slice(3), beads);
      if (!hit) {
        throw new BeadsResolverError(
          `bd record not found for surface id ${trimmed} in workspace ${this.cwd}`,
        );
      }
      return hit;
    }

    if (upper.startsWith("BD-")) {
      try {
        return beadsDomainAdapter.surfaceIdToExternalId(trimmed, { cwd: this.cwd });
      } catch (error) {
        if (error instanceof ForeignWorkspacePrefixError) throw error;
        if (error instanceof BdDomainAdapterError) {
          throw new BeadsResolverError(error.message);
        }
        throw error;
      }
    }

    // Bare bd-native long-id: caller has already verified workspace prefix
    // matches the cwd repo (via `recognizeBareWorkspaceLongId` upstream).
    return trimmed;
  }

  /**
   * GH-852: external-ref lookup arm. Maps a non-BD canonical id like
   * `PROJ-5743` onto the snapshot row tagged
   * `bd update <bd-id> --external-ref proj-5743`, returning the bd
   * long-id for the downstream `bd show` call. Operators opt in by
   * setting `external_ref_prefix` on the `[sources.<name>]` beads block
   * — without it, the resolver has no way to derive the expected ref
   * shape from the canonical id, so callers see a structured error.
   */
  private async resolveByExternalRef(canonicalId: string): Promise<string> {
    const trimmed = canonicalId.trim();
    if (!this.externalRefPrefix) {
      throw new BeadsResolverError(
        `beads source has no external_ref_prefix configured; cannot resolve ${trimmed}`,
      );
    }
    const dashIndex = trimmed.indexOf("-");
    if (dashIndex < 0 || dashIndex === trimmed.length - 1) {
      throw new BeadsResolverError(
        `canonical id ${trimmed} has no numeric suffix to map onto external_ref`,
      );
    }
    const suffix = trimmed.slice(dashIndex + 1).toLowerCase();
    const externalRef = `${this.externalRefPrefix}-${suffix}`;
    const snapshot = await this.loadBeads();
    const hit = snapshot.find(
      (r: BeadsRecord) =>
        r.externalRefs?.[this.externalRefPrefix!] === externalRef
        || r.externalRef === externalRef,
    );
    if (!hit) {
      throw new BeadsResolverError(
        `no bd row with external_ref ${externalRef} in ${this.cwd}`,
      );
    }
    return hit.id;
  }
}
