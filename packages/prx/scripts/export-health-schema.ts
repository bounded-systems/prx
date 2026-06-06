#!/usr/bin/env bun
/**
 * Export the code-health report's Zod schema to a JSON Schema artifact.
 *
 * `src/health/model.ts` is the source of truth for the shape `bun run health
 * --json` emits. This regenerates `schemas/health/health.schema.json` so the Zod
 * type and its Draft-7 contract cannot drift. Mirrors `export-readme-schema.ts`.
 *
 *   bun run scripts/export-health-schema.ts   # (also via `bun run schemas:export`)
 *
 * The drift test (`test/scripts/health-schema.test.ts`) asserts the checked-in
 * artifact matches the regenerated output.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { toJsonSchemaArtifact } from "../src/lib/json-schema.ts";
import { CODE_HEALTH_SCHEMA_NAME, CodeHealthReport } from "../src/health/model.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = resolve(repoRoot, "schemas/health");
mkdirSync(outDir, { recursive: true });

const schema = toJsonSchemaArtifact(CodeHealthReport, CODE_HEALTH_SCHEMA_NAME);
const outPath = resolve(outDir, "health.schema.json");
writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n", "utf8");
console.log(`wrote ${outPath}`);
