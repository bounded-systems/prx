// GH-201 — the keeperd Lima command-runner seam. The Lima drivers inject a fake
// Run in tests; this covers the production `spawnRun` default against a harmless
// real command (the only runtime code in the module).

import { describe, expect, test } from "bun:test";

import { spawnRun } from "../../src/door/lima-exec.ts";

describe("spawnRun", () => {
  test("runs a command to completion and returns its captured result", () => {
    const r = spawnRun("echo", ["hi"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("hi");
    expect(r.stderr).toBe("");
  });

  test("surfaces a non-zero / failed spawn as a RunResult (no throw)", () => {
    const r = spawnRun("keeperd-definitely-not-a-real-binary-xyz", []);
    expect(r.status).not.toBe(0);
    expect(typeof r.stdout).toBe("string");
  });
});
