// Generate packages/prx/openapi.json — the OpenAPI projection of the verb
// registry (verbspec's 4th surface). Mirrors gen-jsr-manifest: `--check` fails
// on drift, otherwise (re)writes. Drift is also gated by test/cli/openapi.test.ts,
// so the committed doc can't fall out of sync with the verbs.
//
//   bun run openapi:render        # write packages/prx/openapi.json
//   bun run openapi:check         # fail if the committed doc is stale

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderOpenApiDocument } from "../src/cli/openapi.ts";

const TARGET = resolve(dirname(fileURLToPath(import.meta.url)), "../openapi.json");
const fresh = renderOpenApiDocument();

if (process.argv.includes("--check")) {
  let onDisk = "";
  try {
    onDisk = readFileSync(TARGET, "utf8");
  } catch {
    onDisk = "";
  }
  if (onDisk !== fresh) {
    console.error("openapi.json out of date — run `bun run openapi:render` and commit the result.");
    process.exit(1);
  }
  console.log("openapi.json up to date.");
} else {
  writeFileSync(TARGET, fresh, "utf8");
  console.log(`wrote ${TARGET}`);
}
