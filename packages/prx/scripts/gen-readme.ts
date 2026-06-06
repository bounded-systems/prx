#!/usr/bin/env bun
/**
 * Render README.md from a single validated source of truth.
 *
 * The variable governance facts live in `community/community.json`; the Layout
 * is derived from each `@bounded-systems/*` package's `description`. Both are
 * projected into a Zod-typed `ReadmeModel` (`src/readme/`) and rendered through
 * `community/templates/readme.md`. Mirrors `scripts/render-community.ts`.
 *
 * Usage:
 *   bun run readme:render   # write README.md
 *   bun run readme:check    # fail if README.md drifts from the sources
 *
 * CI runs --check: any drift between the rendered output and the committed
 * README.md exits non-zero.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { README_OUTPUT, renderReadme } from "../src/readme/build.ts";

function main(): void {
  const check = process.argv.includes("--check");
  const next = renderReadme();

  if (check) {
    let current = "";
    try {
      current = readFileSync(README_OUTPUT, "utf8");
    } catch {
      current = "";
    }
    if (current !== next) {
      console.error(
        "README.md is out of date — run `bun run readme:render` and commit the result.",
      );
      process.exit(1);
    }
    console.log("README.md is up to date");
    return;
  }

  writeFileSync(README_OUTPUT, next, "utf8");
  console.log(`wrote ${README_OUTPUT}`);
}

main();
