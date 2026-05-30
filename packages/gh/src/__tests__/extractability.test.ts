import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = resolve(HERE, "..");

// The gh tool capability: a policy- and budget-gated wrapper over @bounded-systems/proc.
// Depends only on the lower capabilities (proc spawn, policy gate, github-budget
// rate gate, env default) — never the pr-state monolith. gh access is a visible
// import edge over @bounded-systems/proc.
const PROD_ALLOWLIST = new Set<string>([
  "@bounded-systems/env",
  "@bounded-systems/proc",
  "@bounded-systems/policy",
  "@bounded-systems/github-budget",
]);
const TEST_ALLOWLIST = new Set<string>([
  ...PROD_ALLOWLIST,
  "bun:test",
  "node:fs",
  "node:path",
  "node:url",
  "@bounded-systems/gh",
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

const FORBIDDEN_AMBIENT: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bchild_process\b/, "child_process"],
  [/\bspawnSync\b|\bBun\.spawn\b|\bexecSync\b|\bexecFileSync\b/, "process spawn"],
  [/\bDeno\.Command\b/, "Deno subprocess"],
  [/\bprocess\.env\b|\bBun\.env\b/, "ambient env / auth"],
];

describe("@bounded-systems/gh extractability", () => {
  test("imports stay within the allowlist (proc/policy/github-budget/env only)", () => {
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

  test("prod files spawn only via @bounded-systems/proc and read env only via @bounded-systems/env", () => {
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
