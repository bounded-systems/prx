// GH-1768 — JSON Schema artifact parity. Mirrors test/scout/schemas.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { toJsonSchemaArtifact } from "../../src/lib/json-schema.ts";

import { factColumns, factRelations, factSchemas } from "../../src/derive/schemas/relations.ts";

const repoRoot = resolve(import.meta.dir, "../..");

describe("derive JSON Schema artifacts — checked-in vs regenerated parity", () => {
  for (const name of factRelations) {
    test(`schemas/derive/${name}.json matches Zod source`, () => {
      const onDisk = JSON.parse(
        readFileSync(resolve(repoRoot, `schemas/derive/${name}.json`), "utf8"),
      );
      const regenerated = toJsonSchemaArtifact(factSchemas[name], `derive_${name}`);
      expect(onDisk).toEqual(regenerated);
    });
  }

  test("every relation has a column-order entry", () => {
    for (const name of factRelations) {
      expect((factColumns as Record<string, readonly string[]>)[name]).toBeDefined();
    }
  });
});
