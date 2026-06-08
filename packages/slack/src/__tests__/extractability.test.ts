import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = resolve(HERE, "..");

// The slack read surface is a standalone package. At slack .2 (the port +
// types skeleton) the prod files import nothing but their own siblings. Later
// tasks of epic prx-zes widen this allowlist deliberately:
//   .3 policy   → @bounded-systems/policy        (the gate)
//   .5 core     → @bounded-systems/cas           (content-addressing)
//   .6 provenance → @bounded-systems/anchored-chain
//   .8 CLI xport → @bounded-systems/proc          (the sanctioned spawn seam)
// Each widening is a reviewed edge, not a silent reach. Notably absent forever:
// @bounded-systems/auth — the surface holds ZERO authority logic; it receives a
// minted ScopedSlackKey and never resolves credentials itself.
const PROD_ALLOWLIST = new Set<string>([]);

const TEST_ALLOWLIST = new Set<string>([
  ...PROD_ALLOWLIST,
  "bun:test",
  "node:fs",
  "node:path",
  "node:url",
  "@bounded-systems/slack",
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

describe("slack read-surface extractability", () => {
  test("core files import only the reviewed substrate allowlist", () => {
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

// The keymaker separation, enforced structurally: prod files must NEVER read
// ambient env/auth or spawn external tools. A transport is a pure mechanism
// handed a minted key; authority enters only via that key. This guard holds for
// the life of the package — adapters route spawning through @bounded-systems/proc,
// never raw child_process, and never reach for process.env.
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
