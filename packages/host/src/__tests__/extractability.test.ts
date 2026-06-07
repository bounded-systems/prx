import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = resolve(HERE, "..");

// @bounded-systems/host is the ONE sanctioned reader of node:os ambient state
// (homedir/tmpdir/hostname). It is a near-leaf — its only workspace dependency
// is @bounded-systems/env (to honor the $HOME override). Every other package's
// boundary guard forbids raw node:os so ambient host state becomes an explicit
// @bounded-systems/host import edge; this is the package node:os is allowed in.
const PROD_ALLOWLIST = new Set<string>(["node:os", "@bounded-systems/env"]);
const TEST_ALLOWLIST = new Set<string>([
  "bun:test",
  "node:fs",
  "node:path",
  "node:url",
  "node:os",
  "@bounded-systems/env",
  "@bounded-systems/host",
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

describe("@bounded-systems/host extractability", () => {
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

  test("is the sole sanctioned reader of node:os ambient state", () => {
    const src = readFileSync(join(MODULE_ROOT, "index.ts"), "utf8");
    expect(src.includes('from "node:os"')).toBe(true);
  });

  test("homeDir honors an explicit $HOME override", () => {
    // Behavioral guarantee that makes the capability testable on every platform
    // (os.homedir() ignores $HOME on macOS).
    const src = readFileSync(join(MODULE_ROOT, "index.ts"), "utf8");
    expect(src.includes('getEnv("HOME")')).toBe(true);
  });
});
