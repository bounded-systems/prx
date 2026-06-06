#!/usr/bin/env bun
/**
 * Render `.claude/context/project.md` — the committed Claude context doc —
 * from the project graph + root package.json scripts (`src/claude-context/`).
 * Mirrors `scripts/gen-readme.ts`.
 *
 * Usage:
 *   bun run claude-context:render   # write .claude/context/project.md
 *   bun run claude-context:check    # fail if it drifts from the sources
 *
 * Run via `bun run docs:render` / `docs:check` and `prx ci --phase=docs`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { CONTEXT_OUTPUT, renderContextDoc } from "../src/claude-context/build.ts";

function main(): void {
  const check = process.argv.includes("--check");
  const next = renderContextDoc();

  if (check) {
    let current = "";
    try {
      current = readFileSync(CONTEXT_OUTPUT, "utf8");
    } catch {
      current = "";
    }
    if (current !== next) {
      console.error(
        ".claude/context/project.md is out of date — run `bun run claude-context:render` and commit the result.",
      );
      process.exit(1);
    }
    console.log(".claude/context/project.md is up to date");
    return;
  }

  mkdirSync(dirname(CONTEXT_OUTPUT), { recursive: true });
  writeFileSync(CONTEXT_OUTPUT, next, "utf8");
  console.log(`wrote ${CONTEXT_OUTPUT}`);
}

main();
