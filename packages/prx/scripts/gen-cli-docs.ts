// Write (or --check) the generated CLI reference, docs/cli.md.
//
//   bun run packages/prx/scripts/gen-cli-docs.ts            # write
//   bun run packages/prx/scripts/gen-cli-docs.ts --check    # fail on drift
//
// Source of truth is the command registry (src/cli/registry.data.ts). Re-run
// after any registry change and commit; `bun run cli:check` fails otherwise.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../src/repo-root.ts";
import { generateCliDoc } from "../src/cli/docs.ts";

const outPath = join(REPO_ROOT, "docs", "cli.md");
const rendered = generateCliDoc() + "\n";

if (process.argv.includes("--check")) {
  const current = readFileSync(outPath, "utf8");
  if (current !== rendered) {
    console.error("docs/cli.md is stale — run `bun run cli:render` and commit");
    process.exit(1);
  }
  console.log("docs/cli.md is up to date");
} else {
  writeFileSync(outPath, rendered);
  console.log(`wrote ${outPath}`);
}
