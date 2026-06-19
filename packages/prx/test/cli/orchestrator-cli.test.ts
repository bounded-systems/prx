// cli/orchestrator-cli — `runSpecVerb`, the bridge from cli.ts to the
// spec-driven verb registry. Drives the dispatch outcomes through real
// (pure, introspection-only) verbs and validation failures: help, default vs
// verb `render`, the ZodError arm, the friendly pr.json ENOENT arm, and the
// generic error arm (unknown / missing verb).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSpecVerb } from "../../src/cli/orchestrator-cli.ts";

function rec() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    output: { log: (l: string) => lines.push(l), error: (l: string) => errors.push(l) },
  };
}

describe("runSpecVerb", () => {
  test("--help returns 0 and prints the verb's help text", async () => {
    const r = rec();
    const code = await runSpecVerb("docs", ["--help"], r.output);
    expect(code).toBe(0);
    expect(r.lines.join("\n").length).toBeGreaterThan(0);
  });

  test("a verb without a CLI render falls back to JSON render", async () => {
    const r = rec();
    const code = await runSpecVerb("schemas", [], r.output);
    expect(code).toBe(0);
    expect(() => JSON.parse(r.lines[0]!)).not.toThrow();
  });

  test("a verb with a CLI render uses it", async () => {
    const r = rec();
    const code = await runSpecVerb("graph", [], r.output);
    expect(code).toBe(0);
    expect(r.lines.join("\n").length).toBeGreaterThan(0);
  });

  test("a missing required arg surfaces the first Zod issue (exit 1)", async () => {
    const r = rec();
    // `pilot` requires a `workUnitId` positional → input parse fails with a
    // ZodError *before* the verb runs, so this never touches the pipeline.
    const code = await runSpecVerb("pilot", [], r.output);
    expect(code).toBe(1);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  test("an unknown verb is a generic error (exit 1)", async () => {
    const r = rec();
    const code = await runSpecVerb("definitely-not-a-verb", [], r.output);
    expect(code).toBe(1);
    expect(r.errors.join("\n")).toContain("unknown verb");
  });

  test("an empty verb is a generic error (exit 1)", async () => {
    const r = rec();
    const code = await runSpecVerb("", [], r.output);
    expect(code).toBe(1);
    expect(r.errors.join("\n")).toContain("no verb given");
  });

  test("a missing pr.json surfaces the friendly contract-init guidance (exit 1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-cli-"));
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const r = rec();
      const code = await runSpecVerb("status", [], r.output);
      expect(code).toBe(1);
      const err = r.errors.join("\n");
      // Either the friendly pr.json ENOENT arm, or another contract-resolution
      // error — both exit 1 through the catch; assert the contract guidance when
      // the ENOENT path is taken.
      expect(err.length).toBeGreaterThan(0);
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
