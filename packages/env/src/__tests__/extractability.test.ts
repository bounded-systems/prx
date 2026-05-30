import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = resolve(HERE, "..");

// @bounded-systems/env is a leaf with zero imports — and it is the ONE sanctioned reader of
// process.env. Every other package's boundary test forbids raw process.env so
// that ambient config becomes an explicit @bounded-systems/env import edge; this is the
// package that primitive is allowed to live in.
const PROD_ALLOWLIST = new Set<string>([]);
const TEST_ALLOWLIST = new Set<string>([
  "bun:test",
  "node:fs",
  "node:path",
  "node:url",
  "@bounded-systems/env",
]);

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

describe("@bounded-systems/env extractability", () => {
  test("imports stay within the allowlist (a zero-dependency leaf)", () => {
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

  test("is the sole sanctioned reader of process.env", () => {
    // Sanity: the capability does read process.env (that's its whole job).
    const src = readFileSync(join(MODULE_ROOT, "index.ts"), "utf8");
    expect(src.includes("process.env")).toBe(true);
  });
});
