#!/usr/bin/env bun
/**
 * Export the workspace actor Zod schemas to JSON Schema artifacts (GH-1978).
 *
 * The Zod schemas in `src/workspace/schema.ts` are the source of truth
 * for the contract drivers (worktrunk today; devcontainer / nix
 * devShell / CI pre-job tomorrow) must call into. This script
 * regenerates `schemas/workspace/<verb>.{input,output}.json` so the
 * audit substrate and any out-of-tree driver can rely on a stable
 * Draft-7 contract.
 *
 * Usage:
 *   bun run scripts/export-workspace-schema.ts
 *
 * CI asserts idempotence: regeneration produces no `git diff`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { zodToJsonSchema } from "zod-to-json-schema";

import {
  WORKSPACE_VERBS,
  WORKSPACE_INPUT_SCHEMAS,
  WORKSPACE_OUTPUT_SCHEMAS,
} from "../src/workspace/schema.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = resolve(repoRoot, "schemas/workspace");
mkdirSync(outDir, { recursive: true });

for (const verb of WORKSPACE_VERBS) {
  const inputJson = zodToJsonSchema(WORKSPACE_INPUT_SCHEMAS[verb], {
    name: `workspace_${verb}_input`,
    target: "jsonSchema7",
  });
  const outputJson = zodToJsonSchema(WORKSPACE_OUTPUT_SCHEMAS[verb], {
    name: `workspace_${verb}_output`,
    target: "jsonSchema7",
  });
  const inputPath = resolve(outDir, `${verb}.input.json`);
  const outputPath = resolve(outDir, `${verb}.output.json`);
  writeFileSync(inputPath, JSON.stringify(inputJson, null, 2) + "\n", "utf8");
  writeFileSync(outputPath, JSON.stringify(outputJson, null, 2) + "\n", "utf8");
  console.log(`wrote ${inputPath}`);
  console.log(`wrote ${outputPath}`);
}
