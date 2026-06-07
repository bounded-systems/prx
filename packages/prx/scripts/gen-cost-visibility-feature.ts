// Write the generated cost-visibility .feature.
//
//   bun packages/prx/scripts/gen-cost-visibility-feature.ts
//
// Source of truth is services/anthropic.ts (projectAnthropicUsage) via
// src/services/cost_visibility_feature.ts. Re-run after a change there and
// commit; the drift test fails otherwise.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findRepoRoot } from "../src/repo-root.ts";
import { generateCostVisibilityFeature } from "../src/services/cost_visibility_feature.ts";

const REPO_ROOT = findRepoRoot();
const dir = join(REPO_ROOT, "features");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "cost-visibility.feature"), generateCostVisibilityFeature());
console.log("wrote features/cost-visibility.feature");
