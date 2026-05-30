import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = resolve(HERE, "..");

// The scout *core* (content-addressed reads + the provenance bridge) is a
// standalone package: prod files import node builtins plus the lower-layer
// substrate they build on (@bounded-systems/cas, @bounded-systems/anchored-chain) — and nothing else.
// In particular never the pr-state monolith, triage, or fetch. The GH/Notion
// projection verbs (issues/notion) live outside this package as future plugins.
const PROD_ALLOWLIST = new Set<string>([
  "node:fs",
  "node:path",
  "@bounded-systems/cas",
  "@bounded-systems/anchored-chain",
]);

const TEST_ALLOWLIST = new Set<string>([
  ...PROD_ALLOWLIST,
  "bun:test",
  "node:os",
  "node:url",
  "@bounded-systems/scout",
  // tests may exercise the provenance bridge against a real store
  "@bounded-systems/anchored-chain-sqlite",
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

function isInModuleImport(spec: string): boolean {
  return spec.startsWith(".");
}

describe("scout core extractability", () => {
  test("core files import only node builtins + the @bounded-systems/cas, @bounded-systems/anchored-chain substrate", () => {
    const violations: Array<{ file: string; spec: string }> = [];
    for (const file of listTsFiles(MODULE_ROOT)) {
      const isTest = file.includes("/__tests__/");
      const allowlist = isTest ? TEST_ALLOWLIST : PROD_ALLOWLIST;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(IMPORT_RE)) {
        const spec = match[1]!;
        if (isInModuleImport(spec)) continue;
        if (allowlist.has(spec)) continue;
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
