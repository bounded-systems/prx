// GH-1421 — test helpers for building IdentityConfig fixtures in the new
// `[sources.<name>]` registry shape. Most tests previously stamped out
// `{ canonicalIdPattern, isDefault, notion }` literals; this helper keeps
// the per-test diff small by exposing the same axes (pattern + optional
// notion config) and producing the registry shape underneath.

import type { IdentityConfig, NotionIdentityConfig } from "../../src/pr-state/github.ts";

export type LegacyIdentityShape = {
  canonicalIdPattern?: RegExp;
  isDefault?: boolean;
  notion?: NotionIdentityConfig | null;
};

/**
 * Build an `IdentityConfig` from the legacy `{ canonicalIdPattern, isDefault,
 * notion }` shape. Used by tests that wired stub configs before the GH-1421
 * sources-registry rewrite — keeps existing assertions valid without forcing
 * every fixture to be hand-rewritten.
 */
export function buildIdentityFromLegacy(shape: LegacyIdentityShape): IdentityConfig {
  const pattern = shape.canonicalIdPattern ?? /^GH-\d+$/;
  const isDefault = shape.isDefault ?? false;
  const notion = shape.notion ?? null;
  const sources: IdentityConfig["sources"] = {};
  sources.github = {
    name: "github",
    kind: "github",
    canonicalIdPattern: pattern,
    source: "<test>",
  };
  if (notion) {
    sources.notion = {
      name: "notion",
      kind: "notion",
      canonicalIdPattern: pattern,
      source: "<test>",
      notion,
    };
  }
  return {
    sources,
    defaultSourceName: notion ? "notion" : "github",
    isDefault,
  };
}
