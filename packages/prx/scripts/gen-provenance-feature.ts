// prx-1dz (audit surface) — write the generated provenance-ownership .feature.
//
//   bun packages/prx/scripts/gen-provenance-feature.ts
//
// Source of truth is @bounded-systems/policy (ownersOf) + the verify gate
// (provenance/effect-ownership). Re-run after any policy-table / gate change and
// commit; the drift test fails otherwise.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../src/repo-root.ts";
const REPO_ROOT = findRepoRoot();
import { generateProvenanceFeature } from "../src/provenance/ownership_feature.ts";

const dir = join(REPO_ROOT, "features");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "provenance-ownership.feature"), generateProvenanceFeature());
console.log("wrote features/provenance-ownership.feature");
