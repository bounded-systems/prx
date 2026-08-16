// Drift guard for scripts/jsr-manifest.generated.ts — the static list jsr-sync
// projects to JSR. The manifest is generated from each packages/<x>/jsr.json (+
// package.json description); this test fails if a package's jsr.json/description
// changed without regenerating, so the checked-in constant can't go stale.
//
// (This is also why jsr-sync reads the constant, not the filesystem: the file
// reads live here + in the generator, never in the code that makes the request.)

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, renderManifest } from "../../scripts/gen-jsr-manifest.ts";

const GENERATED = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/jsr-manifest.generated.ts",
);

describe("jsr-manifest.generated.ts", () => {
  test("is up to date with `bun run jsr:manifest`", () => {
    const fresh = renderManifest(buildManifest());
    const onDisk = readFileSync(GENERATED, "utf8");
    expect(onDisk, "stale jsr manifest — run `bun run jsr:manifest` and commit the result").toBe(
      fresh,
    );
  });
});
