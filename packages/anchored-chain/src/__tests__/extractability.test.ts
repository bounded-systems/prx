import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = resolve(HERE, '..');

// The pure core: no database. drizzle-orm + bun:sqlite now live in
// @bounded-systems/anchored-chain-sqlite; the core depends only on node:crypto (signing)
// and the @bounded-systems/cas substrate it builds its provenance graph on.
const PROD_ALLOWLIST = new Set([
  'node:crypto',
  '@bounded-systems/cas',
]);

const TEST_ALLOWLIST = new Set([
  ...PROD_ALLOWLIST,
  'bun:test',
  'node:fs',
  'node:path',
  'node:url',
  '@bounded-systems/anchored-chain',
]);

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function isInModuleImport(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('./') || spec.startsWith('../');
}

describe('anchored-chain extractability', () => {
  test('no outbound imports outside the allowlist', () => {
    const violations: Array<{ file: string; spec: string }> = [];
    for (const file of listTsFiles(MODULE_ROOT)) {
      const isTest = file.includes('/__tests__/');
      const allowlist = isTest ? TEST_ALLOWLIST : PROD_ALLOWLIST;
      const source = readFileSync(file, 'utf8');
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
