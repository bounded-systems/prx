// prx-g88.7 (7b) — write the generated capability-envelope .feature.
//
//   bun packages/prx/scripts/gen-envelope-feature.ts
//
// Source of truth is the APPROVAL_MATRIX in src/agents/capability_envelope.ts.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../src/repo-root.ts";
const REPO_ROOT = findRepoRoot();
import { generateEnvelopeFeature } from "../src/agents/capability_envelope.ts";

const dir = join(REPO_ROOT, "features");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "capability-envelope.feature"), generateEnvelopeFeature());
console.log("wrote features/capability-envelope.feature");
