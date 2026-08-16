import { basename } from "node:path";
import type { WorkUnitId } from "@bounded-systems/machine-schema";
import { z } from "zod";

import { adapterForCanonicalId, combinedCanonicalIdPattern } from "../adapters/domain-adapter.ts";
import type { BeadsRecord } from "../triage/triage.ts";

/**
 * The canonical-id shape recognised by prx. Derived from the domain-adapter
 * registry (GH-1536) rather than a hardcoded literal: it is the union of every
 * registered adapter's `surfaceIdPattern` plus the baseline GitHub/Notion
 * shapes. `loadIdentityConfig`'s `isDefault` check compares the user's pinned
 * `canonical_id_pattern` against this `.source` byte-for-byte; per-repo
 * `[identity] canonical_id_pattern` overrides flow through `loadIdentityConfig`
 * independently.
 *
 * The `BdDomainAdapter` (`src/adapters/beads.ts`, GH-1645) contributes the
 * `BD-<8-hex>` arm — the canonical surface for **pin-zero UoWs** (no external
 * domain pinned). The union widens to include `BD-…` once the adapter barrel
 * (`src/adapters/index.ts`) is imported; that's the default ship state.
 * `loadIdentityConfig`'s `isDefault` check sees the wider union accordingly.
 */
export const canonicalWorkUnitIdPattern = combinedCanonicalIdPattern();

export const canonicalWorkUnitIdSchema = z
  .string()
  .regex(
    canonicalWorkUnitIdPattern,
    "must match CANONICAL-ID format (for example GH-456 or NOTION-<32hex>)",
  )
  // GH-2098: casts the validated output to the same unique-symbol WorkUnitId
  // used by `@bounded-systems/machine-schema`, so the two schemas share
  // a single structural brand. This module owns canonical *shape* validation;
  // machine-schema owns the nominal *type* brand.
  .transform((v) => v as WorkUnitId);

export function normalizeCanonicalWorkUnitId(value: string): string {
  return value.trim().toUpperCase();
}

export function isCanonicalWorkUnitId(value: string): boolean {
  return canonicalWorkUnitIdPattern.test(value);
}

export function parseCanonicalWorkUnitId(value: string | null | undefined): WorkUnitId | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // GH-1674: case sensitivity is delegated to the canonical-id pattern itself.
  // Test the trimmed input verbatim first so arms encoded as lowercase-only
  // (e.g. the BD long-id arm, `BD-<prefix:[a-z]…>-…`) survive the seam. Then
  // fall back to a case-folded retry so historically uppercase-stable arms
  // (`GH-\d+`, `NOTION-…`, `BD-<8-hex>`) keep accepting lowercase input.
  // GH-2098: `.test()` proves canonical shape here, so the cast to the branded
  // `WorkUnitId` is sound — this is the single validated return point.
  if (canonicalWorkUnitIdPattern.test(trimmed)) return trimmed as WorkUnitId;
  const upper = trimmed.toUpperCase();
  if (upper !== trimmed && canonicalWorkUnitIdPattern.test(upper)) return upper as WorkUnitId;
  return null;
}

export function requireCanonicalWorkUnitId(value: string, label = "work unit id"): WorkUnitId {
  const normalized = parseCanonicalWorkUnitId(value);
  if (!normalized) {
    throw new Error(
      `${label} must match canonical issue id format (for example GH-456 or NOTION-<32hex>): ${value}`,
    );
  }
  return normalized;
}

export function canonicalWorkUnitIdFromBranchName(
  branch: string | null | undefined,
): WorkUnitId | null {
  return parseCanonicalWorkUnitId(branch);
}

export function canonicalWorkUnitIdFromDirectory(
  path: string | null | undefined,
): WorkUnitId | null {
  if (typeof path !== "string" || path.trim().length === 0) {
    return null;
  }
  return parseCanonicalWorkUnitId(basename(path));
}

export type CanonicalWorkUnitIdHelpers = {
  pattern: RegExp;
  normalize: (value: string) => string;
  isCanonical: (value: string) => boolean;
  parse: (value: string | null | undefined) => string | null;
};

export function buildCanonicalWorkUnitIdHelpers(pattern: RegExp): CanonicalWorkUnitIdHelpers {
  const isCanonical = (value: string): boolean => pattern.test(value);
  const parse = (value: string | null | undefined): string | null => {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    // GH-1674: same case-preservation rule as `parseCanonicalWorkUnitId`.
    // Verbatim test first (preserves lowercase-only arms); case-folded retry
    // keeps uppercase-stable arms tolerant of lowercase input.
    if (isCanonical(trimmed)) return trimmed;
    const upper = trimmed.toUpperCase();
    if (upper !== trimmed && isCanonical(upper)) return upper;
    return null;
  };
  return {
    pattern,
    normalize: normalizeCanonicalWorkUnitId,
    isCanonical,
    parse,
  };
}

/**
 * Surface-id → bd short-id resolution against a pre-loaded bd snapshot
 * (GH-1538). The single dispatch seam every UoW resolver should funnel
 * through: parse the canonical surface id, look up the adapter from the
 * registry, ask the adapter for its external-id projection, and let the
 * adapter resolve. Pure / sync — the caller controls when `bd list --json`
 * runs (and can reuse one snapshot across many resolutions).
 *
 * Case sensitivity is delegated to the canonical-id pattern itself
 * (GH-1674): arms encoded as lowercase-only (the BD long-id arm,
 * `BD-<prefix:[a-z]…>-<ts>-<seq>-<hex8>`) pass through verbatim;
 * arms encoded as uppercase-stable (`GH-\d+`, the `NOTION-…` literal,
 * `BD-<8-hex>`) accept either case via the parser's case-folded retry.
 * The seam never uppercases input unconditionally — doing so silently
 * nulled out the long-id arm before GH-1674.
 *
 * Returns `null` when:
 *   - `surfaceId` is not a canonical id (doesn't match any registered pattern),
 *   - no adapter is registered for the surface id's domain,
 *   - the adapter rejects `surfaceId`'s shape when projecting to external id,
 *   - no bd record in `beads` is pinned to that external id in that domain.
 *
 * Never short-id prefix matching (e.g. `GH-1538` is *not* tried as a bd-id
 * prefix). The adapter is the only thing that maps canonical → external →
 * bd, satisfying the feedback rule that resolution flows through the
 * adapter, never through prefix matching.
 */
export function resolveUoW(
  surfaceId: string,
  beads: BeadsRecord[],
  repoCtx?: { repo?: string; cwd?: string },
): string | null {
  const normalized = parseCanonicalWorkUnitId(surfaceId);
  if (!normalized) return null;
  const adapter = adapterForCanonicalId(normalized);
  if (!adapter) return null;
  let externalId: string;
  try {
    externalId = adapter.surfaceIdToExternalId(normalized, repoCtx);
  } catch {
    return null;
  }
  return adapter.resolveFromBeads(externalId, beads);
}
