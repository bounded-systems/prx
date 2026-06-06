#!/usr/bin/env bun
/**
 * Export the JSON-LD project-graph Zod schema to a JSON Schema artifact.
 *
 * `src/graph/model.ts` is the source of truth for the shape of `prx.jsonld`.
 * This regenerates `schemas/graph/project-graph.schema.json` so the Zod type
 * and its Draft-7 contract cannot drift. Mirrors
 * `scripts/export-readme-schema.ts`.
 *
 * Usage:
 *   bun run scripts/export-graph-schema.ts   # (also via `bun run schemas:export`)
 *
 * The graph test (`test/graph/graph.test.ts`) asserts the checked-in artifact
 * matches the regenerated output.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { toJsonSchemaArtifact } from "../src/lib/json-schema.ts";
import { PROJECT_GRAPH_SCHEMA_NAME, ProjectGraph } from "../src/graph/model.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = resolve(repoRoot, "schemas/graph");
mkdirSync(outDir, { recursive: true });

const schema = toJsonSchemaArtifact(ProjectGraph, PROJECT_GRAPH_SCHEMA_NAME);
const outPath = resolve(outDir, "project-graph.schema.json");
writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n", "utf8");
console.log(`wrote ${outPath}`);
