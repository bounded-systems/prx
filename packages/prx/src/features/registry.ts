// Every generated gherkin .feature, in one place — extracted from the
// gen-*-feature scripts so the `prx features` verb and the scripts render the
// SAME bytes. Each entry is { path, content } where content is exactly what the
// scripts write (the generator's output, verbatim).
//
// Path resolution is LAZY (getRepoRoot inside the function) — never at import;
// the verb dynamic-imports this so the generators' source modules don't load at
// CLI startup.

import { resolve } from "node:path";

import { getRepoRoot } from "@bounded-systems/repo-root";

import { generateProvenanceFeature } from "../provenance/ownership_feature.ts";
import { generateCapabilityFeature } from "../agents/capability_feature.ts";
import { generateEnvelopeFeature } from "../agents/capability_envelope.ts";
import { generateDerivationChainFeature } from "../provenance/derivation_chain_feature.ts";
import { generateCostVisibilityFeature } from "../services/cost_visibility_feature.ts";

/** One committed gherkin feature: absolute path + exact file content. */
export type FeatureArtifact = { path: string; content: string };

/** Every generated .feature, freshly rendered from its source of truth. */
export function featureArtifacts(): FeatureArtifact[] {
  const dir = resolve(getRepoRoot(), "features");
  const at = (file: string, content: string): FeatureArtifact => ({
    path: resolve(dir, file),
    content,
  });
  return [
    at("provenance-ownership.feature", generateProvenanceFeature()),
    at("capability-ownership.feature", generateCapabilityFeature()),
    at("capability-envelope.feature", generateEnvelopeFeature()),
    at("derivation-chain.feature", generateDerivationChainFeature()),
    at("cost-visibility.feature", generateCostVisibilityFeature()),
  ];
}
