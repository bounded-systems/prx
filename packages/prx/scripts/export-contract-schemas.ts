#!/usr/bin/env bun
/**
 * GH-1821 — export contract-trinity Zod schemas to JSON Schema artifacts.
 *
 * Mirrors `scripts/export-{derive,intake,scout}-schemas.ts`. The Zod schemas
 * in `src/machine/contracts.ts` are the source of truth; this script
 * regenerates `schemas/contracts/{agent,artifact,transition}.json` so
 * downstream consumers (CLI inspectors, future actors, audit instruments)
 * can lint contract instances without importing the TS module.
 *
 * Usage:
 *   bun run scripts/export-contract-schemas.ts
 *
 * CI asserts idempotence: regeneration produces no `git diff`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { zodToJsonSchema } from "zod-to-json-schema";

import {
  agentContractSchema,
  artifactContractSchema,
  transitionContractSchema,
} from "../src/machine/contracts.ts";
import {
  blockerReportSchema,
  delegationRecordSchema,
  sprintPlanSchema,
  statusUpdateSchema,
} from "../src/machine/contracts/lifecycle_artifacts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = resolve(repoRoot, "schemas/contracts");
const lifecycleOutDir = resolve(outDir, "lifecycle");
mkdirSync(outDir, { recursive: true });
mkdirSync(lifecycleOutDir, { recursive: true });

const artifacts: Array<{ name: string; schema: unknown }> = [
  {
    name: "agent",
    schema: zodToJsonSchema(agentContractSchema, {
      name: "agent_contract",
      target: "jsonSchema7",
    }),
  },
  {
    name: "artifact",
    schema: zodToJsonSchema(artifactContractSchema, {
      name: "artifact_contract",
      target: "jsonSchema7",
    }),
  },
  {
    name: "transition",
    schema: zodToJsonSchema(transitionContractSchema, {
      name: "transition_contract",
      target: "jsonSchema7",
    }),
  },
];

for (const { name, schema } of artifacts) {
  const outPath = resolve(outDir, `${name}.json`);
  writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n", "utf8");
  console.log(`wrote ${outPath}`);
}

// GH-1822 — lifecycle-axis artifacts. Four live Zod schemas exported into
// `schemas/contracts/lifecycle/` so the four success-criteria artifacts are
// linted at the schema layer without importing TS.
const lifecycleArtifacts: Array<{ name: string; schema: unknown }> = [
  {
    name: "status-update",
    schema: zodToJsonSchema(statusUpdateSchema, {
      name: "status_update",
      target: "jsonSchema7",
    }),
  },
  {
    name: "blocker-report",
    schema: zodToJsonSchema(blockerReportSchema, {
      name: "blocker_report",
      target: "jsonSchema7",
    }),
  },
  {
    name: "delegation-record",
    schema: zodToJsonSchema(delegationRecordSchema, {
      name: "delegation_record",
      target: "jsonSchema7",
    }),
  },
  {
    name: "sprint-plan",
    schema: zodToJsonSchema(sprintPlanSchema, {
      name: "sprint_plan",
      target: "jsonSchema7",
    }),
  },
];

for (const { name, schema } of lifecycleArtifacts) {
  const outPath = resolve(lifecycleOutDir, `${name}.json`);
  writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n", "utf8");
  console.log(`wrote ${outPath}`);
}
