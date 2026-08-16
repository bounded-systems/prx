// The committed health JSON Schema artifact must match the Zod source, and the
// report shape must round-trip. Mirrors the other schema-artifact drift tests.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { toJsonSchemaArtifact } from "../../src/lib/json-schema.ts";
import { CODE_HEALTH_SCHEMA_NAME, CodeHealthReport } from "../../src/health/model.ts";
import { findRepoRoot } from "../../src/repo-root.ts";
const REPO_ROOT = findRepoRoot();

const artifactPath = join(REPO_ROOT, "packages/prx/schemas/health/health.schema.json");

describe("code-health schema", () => {
  test("committed artifact matches the Zod source (no drift)", () => {
    const regenerated = toJsonSchemaArtifact(CodeHealthReport, CODE_HEALTH_SCHEMA_NAME);
    const committed = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(
      committed,
      "schemas/health/health.schema.json is stale — run `bun run schemas:export` and commit",
    ).toEqual(regenerated);
  });

  test("a well-formed report round-trips; a malformed one is rejected", () => {
    const ok = {
      sprawl: { totalLines: 1, fileCount: 1, largest: [{ file: "a.ts", lines: 1 }] },
      coupling: { circularChains: 0, samples: [] },
      deadCode: { count: 0, files: [] },
      productMap: { valueProps: 4, backed: 3, modulesExercised: 12 },
      boundary: { zAnyHoles: 0, rawJsonParse: 0 },
      verbspec: { verbs: 261, withInput: 3, withEvent: 0 },
    };
    expect(CodeHealthReport.parse(ok)).toEqual(ok);
    expect(() => CodeHealthReport.parse({ ...ok, sprawl: { totalLines: -1 } })).toThrow();
  });
});
