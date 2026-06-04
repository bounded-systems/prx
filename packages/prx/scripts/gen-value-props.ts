// prx-8mx — write the forcing-function-backed value-props doc.
//
//   bun packages/prx/scripts/gen-value-props.ts
//
// Executes the forcing-function checks in src/value_props.ts and renders
// docs/value-props.md. Re-run after editing the catalog (or when a claim's
// backing changes); the drift test fails otherwise.

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateValuePropsDoc } from "../src/value_props.ts";

const repoRoot = resolve(import.meta.dir, "../../..");
const out = join(repoRoot, "docs", "value-props.md");
writeFileSync(out, generateValuePropsDoc());
console.log(`wrote docs/value-props.md`);
