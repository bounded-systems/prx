#!/usr/bin/env bun
/**
 * GH-1768 — export derive-side Zod schemas to JSON Schema artifacts.
 *
 * Mirrors `scripts/export-scout-schemas.ts`. The Zod schemas in
 * `src/derive/schemas/relations.ts` are the source of truth; this
 * script regenerates `schemas/derive/<relation>.json` so downstream
 * consumers can lint fact streams without importing the TS module.
 *
 * Usage:
 *   bun run scripts/export-derive-schemas.ts
 *
 * The schemas test (`test/derive/schemas.test.ts`) asserts the
 * checked-in artifacts match the regenerated output — running the
 * script after a schema change is required before committing.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { toJsonSchemaArtifact } from "../src/lib/json-schema.ts";

import {
  factRelations,
  factSchemas,
} from "../src/derive/schemas/relations.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = resolve(repoRoot, "schemas/derive");
mkdirSync(outDir, { recursive: true });

for (const name of factRelations) {
  const schema = toJsonSchemaArtifact(factSchemas[name], `derive_${name}`);
  const outPath = resolve(outDir, `${name}.json`);
  writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n", "utf8");
  console.log(`wrote ${outPath}`);
}
