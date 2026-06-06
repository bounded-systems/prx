#!/usr/bin/env bun
/**
 * Render `prx.jsonld` — the project's hostable JSON-LD graph (the token store).
 *
 * Projects `community/community.json` + each `@bounded-systems/*` package's
 * `description` into a schema.org `@graph` (`src/graph/`), serialized to the
 * repo-root `prx.jsonld` so it can be published from the repo (raw / Pages) as
 * linked data. The README reads its tokens from the same graph. Mirrors
 * `scripts/gen-readme.ts`.
 *
 * Usage:
 *   bun run jsonld:render   # write prx.jsonld
 *   bun run jsonld:check    # fail if prx.jsonld drifts from the sources
 *
 * CI runs --check: any drift between the rendered graph and the committed
 * prx.jsonld exits non-zero.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { GRAPH_OUTPUT, renderGraph } from "../src/graph/build.ts";

function main(): void {
  const check = process.argv.includes("--check");
  const next = renderGraph();

  if (check) {
    let current = "";
    try {
      current = readFileSync(GRAPH_OUTPUT, "utf8");
    } catch {
      current = "";
    }
    if (current !== next) {
      console.error(
        "prx.jsonld is out of date — run `bun run jsonld:render` and commit the result.",
      );
      process.exit(1);
    }
    console.log("prx.jsonld is up to date");
    return;
  }

  writeFileSync(GRAPH_OUTPUT, next, "utf8");
  console.log(`wrote ${GRAPH_OUTPUT}`);
}

main();
