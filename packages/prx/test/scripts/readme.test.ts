// README codegen parity — the committed README.md and the README model's JSON
// Schema artifact must match what the sources regenerate. Mirrors the
// community render drift gate and the derive-schema parity test.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { toJsonSchemaArtifact } from "../../src/lib/json-schema.ts";
import { README_OUTPUT, buildReadmeModel, renderReadme } from "../../src/readme/build.ts";
import { README_MODEL_SCHEMA_NAME, ReadmeModel } from "../../src/readme/model.ts";

const repoRoot = resolve(import.meta.dir, "../..");

describe("README codegen", () => {
  test("README.md matches the rendered sources (run `bun run readme:render`)", () => {
    const onDisk = readFileSync(README_OUTPUT, "utf8");
    expect(onDisk).toEqual(renderReadme());
  });

  test("readme.schema.json matches the Zod model (run `bun run schemas:export`)", () => {
    const onDisk = JSON.parse(
      readFileSync(resolve(repoRoot, "schemas/readme/readme.schema.json"), "utf8"),
    );
    const regenerated = toJsonSchemaArtifact(ReadmeModel, README_MODEL_SCHEMA_NAME);
    expect(onDisk).toEqual(regenerated);
  });

  test("the model validates the real sources with every package described", () => {
    const model = buildReadmeModel();
    // buildReadmeModel already `.parse()`s; assert the shape we render against.
    expect(model.cli.name).toBe("@bounded-systems/prx");
    expect(model.libraries.length).toBeGreaterThan(0);
    expect(model.libraries.every((p) => p.description.length > 0)).toBe(true);
    // Libraries are sorted by short name and exclude the CLI package.
    const shorts = model.libraries.map((p) => p.short);
    expect(shorts).toEqual([...shorts].sort((a, b) => a.localeCompare(b)));
    expect(shorts).not.toContain("prx");
  });
});
