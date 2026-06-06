// The committed CLI reference must not drift from the registry it projects.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateCliDoc } from "../../src/cli/docs.ts";
import { prxCommandRegistry } from "../../src/cli/registry.data.ts";
import { REPO_ROOT } from "../../src/repo-root.ts";

describe("CLI reference (docs/cli.md)", () => {
  test("committed doc matches the generator (no drift)", () => {
    const committed = readFileSync(join(REPO_ROOT, "docs/cli.md"), "utf8");
    expect(
      committed,
      "docs/cli.md is stale — run `bun run cli:render` and commit",
    ).toBe(generateCliDoc() + "\n");
  });

  test("every registry command appears in the reference", () => {
    const doc = generateCliDoc();
    for (const c of prxCommandRegistry) {
      expect(doc, `missing command: ${c.name}`).toContain(`\`${c.name}\``);
    }
  });
});
