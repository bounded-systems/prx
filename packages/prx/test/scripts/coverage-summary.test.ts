import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// coverage-summary.ts is a standalone script (runs main() on import), so drive
// it as a subprocess. Focus: the fail-closed behaviour (GH-664) — a coverage run
// that produced no data must FAIL a gated invocation rather than skip.

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/coverage-summary.ts",
);

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cov-summary-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

// A minimal lcov record for one source file at `hit/found` line coverage.
function lcov(path: string, found: number, hit: number): string {
  return `SF:${path}\nLF:${found}\nLH:${hit}\nend_of_record\n`;
}

describe("coverage-summary fail-closed (GH-664)", () => {
  test("missing report WITH a gate → exits 1", () => {
    const r = run([join(dir, "absent.info"), "--min", "85"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("fail-closed");
  });

  test("missing report WITHOUT a gate → exits 0 (report-only)", () => {
    const r = run([join(dir, "absent.info")]);
    expect(r.code).toBe(0);
  });

  test("empty report WITH a gate → exits 1", () => {
    const f = join(dir, "empty.info");
    writeFileSync(f, "");
    const r = run([f, "--min", "85"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("fail-closed");
  });

  test("report with data above the floor → exits 0", () => {
    const f = join(dir, "good.info");
    writeFileSync(f, lcov("packages/x/src/a.ts", 100, 95));
    const r = run([f, "--min", "85"]);
    expect(r.code).toBe(0);
  });

  test("report with data below the global floor → exits 1", () => {
    const f = join(dir, "low.info");
    writeFileSync(f, lcov("packages/x/src/a.ts", 100, 50));
    const r = run([f, "--min", "85"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Global coverage gate failed");
  });
});
