import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The community health files (LICENSE, CODE_OF_CONDUCT.md, SECURITY.md,
// CONTRIBUTING.md) are rendered from `community/community.json` + the pinned
// templates. This asserts the committed files match a fresh render and that the
// source data is schema-valid — the same "regeneration produces no diff"
// guard the schema-export scripts use.

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, "..", "..", "scripts", "render-community.ts");

describe("community health files", () => {
  test("committed files match a fresh render (no drift) and data is schema-valid", () => {
    const result = Bun.spawnSync(["bun", "run", scriptPath, "--check"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stderr.toString() + result.stdout.toString();
    expect(output).not.toContain("failed schema validation");
    expect(result.exitCode, output).toBe(0);
  });
});
