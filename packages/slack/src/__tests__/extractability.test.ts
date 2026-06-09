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
// @bounded-systems/auth — this package never RESOLVES a credential or touches a
// secret. It may CONTAIN scope logic (slackScopedKeymaker) but only wraps an
// opaque, structurally-typed base keymaker whose closure holds the token; the
// secret never enters this package. The composition root supplies the base.
const PROD_ALLOWLIST = new Set<string>([
  "@bounded-systems/policy", // .3 — the policy gate
  "@bounded-systems/cas", // .5 — content-addressing
  "@bounded-systems/anchored-chain", // .6 — the provenance ledger
]);

const TEST_ALLOWLIST = new Set<string>([
  ...PROD_ALLOWLIST,
  "bun:test",
  "node:fs",
  "node:path",
  "node:url",
  "@bounded-systems/slack",
  // .6 provenance tests exercise the bridge against a real store
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
//
// SCOPE OF THIS GUARANTEE: this is a SOURCE-LEVEL LINT at the in-process Bun
// layer, not a runtime sandbox. It catches *accidental* ambient reach in our own
// source; it cannot stop malicious or transitive in-process code from touching
// env/spawn (no syscall gate, no memory isolation). Real in-process enforcement
// = SES/hardened-JS Compartments (no runtime swap), Deno --allow-* (GH-1836), or
// the WASI component model. Note prx ALSO isolates at the agent layer: under
// `--vm` the whole agent runs in a Lima microVM. Isolation is a layered profile,
// not a single tier. See [[prx-capability-enforcement-level]].
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
