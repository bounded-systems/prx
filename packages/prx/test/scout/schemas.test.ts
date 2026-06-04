// GH-1420 — JSON Schema artifact parity for scout-side Zod schemas.
// Mirrors `test/intake/schemas.test.ts` (GH-1258): the checked-in artifact
// must match the regenerated output, and the artifact must be valid Draft-7.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { toJsonSchemaArtifact } from "../../src/lib/json-schema.ts";

import { scoutNotionResultSchema } from "../../src/scout/notion.ts";

const repoRoot = resolve(import.meta.dir, "../..");

describe("scout JSON Schema artifacts — checked-in vs regenerated parity", () => {
  test("schemas/scout/notion.json matches scoutNotionResultSchema", () => {
    const onDisk = JSON.parse(
      readFileSync(resolve(repoRoot, "schemas/scout/notion.json"), "utf8"),
    );
    const regenerated = toJsonSchemaArtifact(
      scoutNotionResultSchema,
      "scout_notion_result",
    );
    expect(onDisk).toEqual(regenerated);
  });

  test("schemas/scout/notion.json is valid Draft-7 with the expected definition", () => {
    const onDisk = JSON.parse(
      readFileSync(resolve(repoRoot, "schemas/scout/notion.json"), "utf8"),
    );
    expect(onDisk.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(onDisk.definitions.scout_notion_result).toBeDefined();
  });
});
