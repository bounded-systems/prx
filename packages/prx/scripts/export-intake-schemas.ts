#!/usr/bin/env bun
/**
 * Export per-intake-type Zod schemas to JSON Schema artifacts (GH-1258).
 *
 * The Zod schemas in `src/intake/schemas/` are the source of truth.
 * This script regenerates `schemas/intake/<type>.json` from them so
 * downstream consumers (scout JSONL, audit instruments) can rely on a
 * stable Draft-7 contract for the `prx intake <type>` body shape.
 *
 * GH-1359: each property is decorated with `x-prx-actions-bearing` and
 * `x-prx-heading` vendor extensions sourced from
 * `INTAKE_BODY_FIELDS_META` so downstream consumers can read the parser
 * contract directly from the artifact.
 *
 * Usage:
 *   bun run schemas:export
 *
 * CI asserts idempotence: regeneration produces no `git diff`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildIntakeJsonSchema } from "../src/intake/schemas/export_json.ts";
import { INTAKE_BODY_SCHEMA_TYPES } from "../src/intake/schemas/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = resolve(repoRoot, "schemas/intake");
mkdirSync(outDir, { recursive: true });

for (const type of INTAKE_BODY_SCHEMA_TYPES) {
  const json = buildIntakeJsonSchema(type);
  const outPath = resolve(outDir, `${type}.json`);
  writeFileSync(outPath, JSON.stringify(json, null, 2) + "\n", "utf8");
  console.log(`wrote ${outPath}`);
}
