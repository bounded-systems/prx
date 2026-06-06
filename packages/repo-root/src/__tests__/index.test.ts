import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { CommandRunner } from "@bounded-systems/proc";
import { findRepoRoot, getRepoRoot, resetRepoRootCache } from "../index.ts";

afterEach(resetRepoRootCache);

describe("findRepoRoot", () => {
  test("walks to the enclosing checkout (has a .git entry)", () => {
    const root = findRepoRoot();
    expect(existsSync(resolve(root, ".git"))).toBe(true);
  });

  test("throws when no .git ancestor exists", () => {
    expect(() => findRepoRoot("/")).toThrow(/no .git ancestor/);
  });
});

describe("getRepoRoot", () => {
  const fakeRun =
    (stdout: string): CommandRunner =>
    () => ({ stdout, stderr: "", status: 0 });

  test("resolves from the injected git toplevel and memoizes", () => {
    let calls = 0;
    const run: CommandRunner = (...args) => {
      calls++;
      return fakeRun("/work/repo\n")(...args);
    };
    expect(getRepoRoot("/work/repo/sub", run)).toBe("/work/repo");
    expect(getRepoRoot("/work/repo/sub", run)).toBe("/work/repo");
    expect(calls).toBe(1); // memoized — git invoked once
  });

  test("falls back to cwd when git reports nothing (not a repo)", () => {
    expect(getRepoRoot("/somewhere", fakeRun(""))).toBe("/somewhere");
  });
});
