#!/usr/bin/env bun
/**
 * GH-1823 — export audit-side Zod schemas to JSON Schema artifacts.
 *
 * Mirrors `scripts/export-derive-schemas.ts`. The Zod schemas in
 * `src/audit/artifact-types.ts` are the source of truth; this script
 * regenerates `schemas/audit/<name>.json` so sibling shards
 * (GH-1817 PatchProposal, GH-1818 verification artifacts, GH-1821 contract
 * trinity, GH-1822 Scrum-fit lifecycle) can validate payloads against the
 * pre-committed artifact-type vocabulary without importing the TS module.
 *
 * Usage:
 *   bun run scripts/export-audit-schemas.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { zodToJsonSchema } from "zod-to-json-schema";

import {
  artifactSlotSchema,
  artifactStatusSchema,
  artifactTypeSchema,
} from "../src/audit/artifact-types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = resolve(repoRoot, "schemas/audit");
mkdirSync(outDir, { recursive: true });

const exports = [
  { name: "artifact-type", schema: artifactTypeSchema },
  { name: "artifact-status", schema: artifactStatusSchema },
  { name: "artifact-slot", schema: artifactSlotSchema },
] as const;

for (const { name, schema } of exports) {
  const json = zodToJsonSchema(schema, {
    name: `audit_${name.replace(/-/g, "_")}`,
    target: "jsonSchema7",
  });
  const outPath = resolve(outDir, `${name}.json`);
  writeFileSync(outPath, JSON.stringify(json, null, 2) + "\n", "utf8");
  console.log(`wrote ${outPath}`);
}
