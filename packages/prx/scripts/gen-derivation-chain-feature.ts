// Write the generated derivation-chain .feature.
//
//   bun packages/prx/scripts/gen-derivation-chain-feature.ts
//
// Source of truth is @bounded-systems/anchored-chain's digest behavior (via
// src/provenance/derivation_chain_feature.ts). Re-run after any change there and
// commit; the drift test fails otherwise.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findRepoRoot } from "../src/repo-root.ts";
import { generateDerivationChainFeature } from "../src/provenance/derivation_chain_feature.ts";

const REPO_ROOT = findRepoRoot();
const dir = join(REPO_ROOT, "features");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "derivation-chain.feature"), generateDerivationChainFeature());
console.log("wrote features/derivation-chain.feature");
