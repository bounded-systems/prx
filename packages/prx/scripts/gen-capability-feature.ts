// prx-g88.7 (7a) — write the generated capability-ownership .feature.
//
//   bun packages/prx/scripts/gen-capability-feature.ts
//
// Source of truth is @bounded-systems/policy (POLICY_TABLE). Re-run after any
// policy-table change and commit; the drift test fails otherwise.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateCapabilityFeature } from "../src/agents/capability_feature.ts";

const repoRoot = resolve(import.meta.dir, "../../..");
const dir = join(repoRoot, "features");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "capability-ownership.feature"), generateCapabilityFeature());
console.log("wrote features/capability-ownership.feature");
