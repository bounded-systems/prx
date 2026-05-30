/**
 * GH-1318: UoW-aware canonical-id extractor.
 *
 * Scans a free-text blob (typically `body + " " + title` from a PR or issue)
 * for canonical surface ids — `GH-\d+`, `NOTION-…`, `BD-…`. The scanner is
 * driven by the identity overlay's `canonicalIdPattern` (loaded via
 * `loadIdentityConfig`) so per-repo overrides flow through automatically.
 *
 * Used by:
 *   - `prx submit body-template` — resolve each `--closes <id>` arg through
 *     the adapter registry before emitting `Closes #N` lines.
 *   - `prx submit postmerge`     — sweep a merged PR's body+title for refs,
 *     subtract `closingIssuesReferences`, close the rest.
 *
 * Postmerge filters the extractor's output to `GH-` refs at the close step
 * (only GitHub issues are reachable via `gh issue close`); the extractor
 * itself stays UoW-general so body-template can resolve any adapter.
 */

import { canonicalIdPatternForIdentity } from "../adapters/domain-adapter.ts";
import { effectiveCanonicalIdPattern, type IdentityConfig } from "../pr-state/github.ts";

function unanchor(source: string): string {
  return source.replace(/^\^/, "").replace(/\$$/, "");
}

/**
 * Build a global-flag scanner from the identity overlay's anchored canonical
 * pattern. Strips the leading `^`/trailing `$` so `matchAll` can sweep the
 * blob; case-insensitive to match `parseCanonicalWorkUnitId`'s fallback.
 */
export function buildCanonicalIdScanner(identity: IdentityConfig): RegExp {
  const anchored = canonicalIdPatternForIdentity({
    canonicalIdPattern: effectiveCanonicalIdPattern(identity),
    isDefault: identity.isDefault,
  });
  return new RegExp(unanchor(anchored.source), "gi");
}

/**
 * Extract canonical ids from a free-text blob in source order, deduped.
 * Comparison is case-insensitive (the returned id preserves the first-seen
 * casing). Returns `[]` on null/empty input.
 */
export function extractCanonicalRefs(
  blob: string | null | undefined,
  identity: IdentityConfig,
): string[] {
  if (typeof blob !== "string" || blob.length === 0) return [];
  const scanner = buildCanonicalIdScanner(identity);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of blob.matchAll(scanner)) {
    const raw = match[0];
    const key = raw.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}
