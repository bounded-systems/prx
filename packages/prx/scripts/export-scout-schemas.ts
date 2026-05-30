#!/usr/bin/env bun
/**
 * Export scout-side Zod schemas to JSON Schema artifacts (GH-1420).
 *
 * The Zod schemas in `src/scout/` are the source of truth. This script
 * regenerates `schemas/scout/<verb>.json` from them so downstream consumers
 * (planner dispatch envelopes, audit instruments) can rely on a stable
 * Draft-7 contract for the `prx scout <verb>` JSON envelope.
 *
 * Usage:
 *   bun run schemas:export
 *
 * CI asserts idempotence: regeneration produces no `git diff`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { zodToJsonSchema } from "zod-to-json-schema";

import { scoutNotionResultSchema } from "../src/scout/notion.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = resolve(repoRoot, "schemas/scout");
mkdirSync(outDir, { recursive: true });

const artifacts: Array<{ name: string; schema: unknown }> = [
  {
    name: "notion",
    schema: zodToJsonSchema(scoutNotionResultSchema, {
      name: "scout_notion_result",
      target: "jsonSchema7",
    }),
  },
];

for (const { name, schema } of artifacts) {
  const outPath = resolve(outDir, `${name}.json`);
  writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n", "utf8");
  console.log(`wrote ${outPath}`);
}
