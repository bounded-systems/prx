import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = resolve(HERE, "..");

// @bounded-systems/repo-root is the ONE sanctioned root-resolution point. It may
// touch node:fs (the `.git`-marker walk) + node:path, and shells out only through
// @bounded-systems/proc — never raw child_process. Every other package's boundary
// test forbids reimplementing root discovery so it stays this single edge.
const PROD_ALLOWLIST = new Set<string>(["node:fs", "node:path", "@bounded-systems/proc"]);
const TEST_ALLOWLIST = new Set<string>([...PROD_ALLOWLIST, "bun:test", "node:url"]);

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function listTsFiles(d: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(d)) {
    const full = join(d, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("@bounded-systems/repo-root extractability", () => {
  test("imports stay within the allowlist", () => {
    const violations: Array<{ file: string; spec: string }> = [];
    for (const file of listTsFiles(MODULE_ROOT)) {
      const isTest = file.includes("/__tests__/");
      const allowlist = isTest ? TEST_ALLOWLIST : PROD_ALLOWLIST;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(IMPORT_RE)) {
        const spec = match[1]!;
        if (spec.startsWith(".")) continue;
        if (allowlist.has(spec)) continue;
        violations.push({ file: relative(MODULE_ROOT, file), spec });
      }
    }
    expect(violations).toEqual([]);
  });
});
