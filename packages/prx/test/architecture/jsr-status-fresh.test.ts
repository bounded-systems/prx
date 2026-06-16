// Drift guard for docs/jsr-publishing.md — the generated JSR publishing handoff
// (status table from the READY set + manifest, plus the per-package loop). Fails
// if the READY set or package versions changed without regenerating, so the
// checked-in doc can't go stale. Regenerate: `bun run jsr:status`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "../../scripts/gen-jsr-status.ts";

const DOC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docs/jsr-publishing.md");

describe("docs/jsr-publishing.md", () => {
  test("is up to date with `bun run jsr:status`", () => {
    const onDisk = readFileSync(DOC, "utf8");
    expect(onDisk, "stale jsr status doc — run `bun run jsr:status` and commit the result").toBe(
      render(),
    );
  });
});
