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
import { runBdShow } from "@bounded-systems/bd";
import { loadAllBeads as defaultLoadAllBeads, type BeadsRecord } from "../../triage/triage.ts";
import { defaultRunner, type CommandRunner } from "../github.ts";
import type { ResolvedWorkUnit, WorkUnitResolver } from "./types.ts";

export type BeadsResolverDeps = {
  /** `bd show <id> --json` runner. Defaults to {@link runBdShow}. */
  bdShow?: typeof runBdShow;
  /** Snapshot loader for the BD-<8hex> arm. Defaults to {@link loadAllBeads}. */
  loadAllBeads?: (cwd: string) => BeadsRecord[];
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

  private readonly bdShow: typeof runBdShow;
  private readonly loadAllBeads: (cwd: string) => BeadsRecord[];
  private readonly externalRefPrefix: string | null;

  constructor(
    private readonly cwd: string,
    deps: BeadsResolverDeps = {},
  ) {
    this.bdShow = deps.bdShow ?? runBdShow;
    this.loadAllBeads = deps.loadAllBeads ?? ((cwd) => defaultLoadAllBeads(undefined, undefined, cwd));
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
      ? this.toBdLongId(canonicalId)
      : this.resolveByExternalRef(canonicalId);
    const result = this.bdShow(longId, this.cwd);
    if (!result.ok) {
      const detail = (result.stderr || result.stdout || "").trim();
      throw new BeadsResolverError(
        `bd show ${longId}: exit ${result.exitCode}${detail ? ` — ${detail}` : ""}`,
      );
    }
    const record = result.record;
    const state =
      record.status === "closed" || record.status === "resolved"
        ? "closed"
        : "open";
    return {
      id: canonicalId,
      title: record.title,
      body: record.description ?? null,
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
  toBdLongId(canonicalId: string): string {
    const trimmed = canonicalId.trim();
    if (trimmed.length === 0) {
      throw new BeadsResolverError("bd id must not be empty");
    }
    const upper = trimmed.toUpperCase();

    if (/^BD-[0-9A-F]{8}$/.test(upper)) {
      const beads = this.loadAllBeads(this.cwd);
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
  private resolveByExternalRef(canonicalId: string): string {
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
    const snapshot = this.loadAllBeads(this.cwd);
    const hit = snapshot.find(
      (r) =>
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
