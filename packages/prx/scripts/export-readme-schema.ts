#!/usr/bin/env bun
/**
 * Export the README data model's Zod schema to a JSON Schema artifact.
 *
 * `src/readme/model.ts` is the source of truth for the typed intermediate the
 * README is rendered from. This script regenerates
 * `schemas/readme/readme.schema.json` so the Zod type and its Draft-7 contract
 * cannot drift. Mirrors `scripts/export-derive-schemas.ts`.
 *
 * Usage:
 *   bun run scripts/export-readme-schema.ts   # (also via `bun run schemas:export`)
 *
 * The README test (`test/scripts/readme.test.ts`) asserts the checked-in
 * artifact matches the regenerated output.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { toJsonSchemaArtifact } from "../src/lib/json-schema.ts";
import { README_MODEL_SCHEMA_NAME, ReadmeModel } from "../src/readme/model.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = resolve(repoRoot, "schemas/readme");
mkdirSync(outDir, { recursive: true });

const schema = toJsonSchemaArtifact(ReadmeModel, README_MODEL_SCHEMA_NAME);
const outPath = resolve(outDir, "readme.schema.json");
writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n", "utf8");
console.log(`wrote ${outPath}`);
