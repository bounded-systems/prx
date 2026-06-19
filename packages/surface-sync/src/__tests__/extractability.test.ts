import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = resolve(HERE, "..");

// The package boundary (precursor to a service boundary). surface-sync prod
// files may import in-module siblings (`./…`) plus exactly one acknowledged
// edge: @bounded-systems/disposition (the classifier / "label" actor it builds on). The
// github monolith, pr-state, triage, and machine are all forbidden —
// surface-sync receives state via the BoardSnapshot contract and never reaches
// into the reader. (The work-unit-id normalization it once imported is now a
// trivial inlined helper, so that edge is gone.)
const PROD_CROSS_MODULE_ALLOWLIST = new Set<string>(["@bounded-systems/disposition"]);

const TEST_ALLOWLIST = new Set<string>([
  "bun:test",
  "@bounded-systems/surface-sync",
  "@bounded-systems/disposition",
  "node:fs",
  "node:path",
  "node:url",
]);

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function isInModule(spec: string): boolean {
  // Flat module: in-module imports are sibling `./x.ts`.
  return spec.startsWith("./");
}

describe("surface-sync module boundary", () => {
  test("prod files import only in-module siblings + allowlisted edges (never the github monolith)", () => {
    const violations: Array<{ file: string; spec: string }> = [];
    for (const file of listTsFiles(MODULE_ROOT)) {
      const isTest = file.includes("/__tests__/");
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(IMPORT_RE)) {
        const spec = match[1]!;
        if (isInModule(spec)) continue;
        if (isTest && TEST_ALLOWLIST.has(spec)) continue;
        if (!isTest && PROD_CROSS_MODULE_ALLOWLIST.has(spec)) continue;
        violations.push({ file: relative(MODULE_ROOT, file), spec });
      }
    }
    expect(violations).toEqual([]);
  });
});

// Hidden (non-import) dependencies: ambient authority that escapes import
// analysis. A standalone package must not silently shell out to external tools
// or read ambient env/auth — those are dependencies too (the anchored-chain
// "no ambient authority" thesis; the GH-1836 Deno --allow-run/--allow-env gates).
const FORBIDDEN_AMBIENT: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bchild_process\b/, "child_process"],
  [/\bspawnSync\b|\bBun\.spawn\b|\bexecSync\b|\bexecFileSync\b/, "process spawn"],
  [/\bDeno\.Command\b/, "Deno subprocess"],
  [/\bprocess\.env\b|\bBun\.env\b/, "ambient env / auth"],
];

describe("no hidden ambient dependencies", () => {
  test("prod files never spawn external tools or read ambient env/auth", () => {
    const offenders: Array<{ file: string; what: string }> = [];
    for (const file of listTsFiles(MODULE_ROOT)) {
      if (file.includes("/__tests__/")) continue;
      const source = readFileSync(file, "utf8");
      for (const [re, what] of FORBIDDEN_AMBIENT) {
        if (re.test(source)) {
          offenders.push({ file: relative(MODULE_ROOT, file), what });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
