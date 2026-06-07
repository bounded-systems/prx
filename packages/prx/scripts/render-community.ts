#!/usr/bin/env bun
/**
 * Render the community health files from a single validated source of truth.
 *
 * `community/community.json` holds the variable facts (project, copyright,
 * license, security, conduct), validated against its JSON Schema and slotted into
 * the pinned templates in `community/templates/`. The rendering itself lives in
 * `src/community/build.ts` (`renderCommunityTargets`), shared with the spec-driven
 * `prx docs` verb; this script is the thin write/check wrapper.
 *
 *   bun run scripts/render-community.ts            # write the files
 *   bun run scripts/render-community.ts --check    # fail if rendering drifts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { findRepoRoot } from "../src/repo-root.ts";
import { renderCommunityTargets } from "../src/community/build.ts";

const check = process.argv.includes("--check");
const repoRoot = findRepoRoot();
const drift: string[] = [];

for (const { output, content } of renderCommunityTargets()) {
  const outPath = resolve(repoRoot, output);
  if (check) {
    let current = "";
    try {
      current = readFileSync(outPath, "utf8");
    } catch {
      current = "";
    }
    if (current !== content) drift.push(output);
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, content, "utf8");
    console.log(`wrote ${outPath}`);
  }
}

if (check) {
  if (drift.length > 0) {
    console.error(
      `community files are out of date: ${drift.join(", ")}\n` +
        `run \`bun run community:render\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log("community files are up to date");
}
