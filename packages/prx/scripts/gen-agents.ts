// prx-g88.1 — write the generated actor sub-agent docs to `.claude/agents/`.
//
//   bun packages/prx/scripts/gen-agents.ts
//
// Source of truth is @bounded-systems/policy (POLICY_TABLE) via
// src/agents/generate.ts. Re-run after any policy-table change and commit the
// result; packages/prx/test/agents/generate.test.ts fails on drift.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateAllAgentDocs } from "../src/agents/generate.ts";

const repoRoot = resolve(import.meta.dir, "../../..");
const agentsDir = join(repoRoot, ".claude", "agents");
mkdirSync(agentsDir, { recursive: true });

const docs = generateAllAgentDocs();
for (const [name, content] of docs) {
  writeFileSync(join(agentsDir, name), content);
  console.log(`wrote .claude/agents/${name}`);
}
console.log(`\n${docs.size} actor sub-agent docs generated from POLICY_TABLE.`);
