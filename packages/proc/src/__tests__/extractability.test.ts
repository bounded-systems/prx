import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = resolve(HERE, "..");

// @bounded-systems/proc is the ONE sanctioned spawn point. It may touch node:child_process
// (the primitive it wraps) + node:os, and reaches the ambient environment only
// through @bounded-systems/env — never process.env directly. Every other package's boundary
// test forbids raw spawn so that shelling out becomes an explicit @bounded-systems/proc
// import edge; this is where that primitive is allowed to live.
const PROD_ALLOWLIST = new Set<string>([
  "node:child_process",
  "node:os",
  "node:fs",
  "node:path",
  "@bounded-systems/env",
  "zod",
  "@bounded-systems/policy",
]);
const TEST_ALLOWLIST = new Set<string>([
  ...PROD_ALLOWLIST,
  "bun:test",
  "node:fs",
  "node:path",
  "node:url",
  "@bounded-systems/proc",
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

describe("@bounded-systems/proc extractability", () => {
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

  test("reaches ambient env only through @bounded-systems/env, never process.env directly", () => {
    for (const file of listTsFiles(MODULE_ROOT)) {
      if (file.includes("/__tests__/")) continue;
      const src = readFileSync(file, "utf8");
      expect(src.includes("process.env")).toBe(false);
    }
  });
});
