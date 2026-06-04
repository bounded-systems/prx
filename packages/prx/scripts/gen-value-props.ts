// prx-8mx — write the forcing-function-backed value-props doc.
//
//   bun packages/prx/scripts/gen-value-props.ts
//
// Executes the forcing-function checks in src/value_props.ts and renders
// docs/value-props.md. Re-run after editing the catalog (or when a claim's
// backing changes); the drift test fails otherwise.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../src/repo-root.ts";
import { generateStatusDoc, generateValuePropsDoc } from "../src/value_props.ts";

const repoRoot = REPO_ROOT;
writeFileSync(join(repoRoot, "docs", "value-props.md"), generateValuePropsDoc());
console.log("wrote docs/value-props.md");
// The top of the bubble-up: forcing functions → value props → STATUS.md.
writeFileSync(join(repoRoot, "STATUS.md"), generateStatusDoc());
console.log("wrote STATUS.md");
