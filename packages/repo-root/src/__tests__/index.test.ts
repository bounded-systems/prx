import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { CommandRunner } from "@bounded-systems/proc";
import { findRepoRoot, getRepoRoot, resetRepoRootCache, resolveRepoRoot } from "../index.ts";

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

describe("resolveRepoRoot", () => {
  test("returns the git toplevel of the given dir, passing -C and no memo", () => {
    const seen: string[][] = [];
    const run: CommandRunner = (cmd) => {
      seen.push(cmd);
      return { stdout: "/work/repo\n", stderr: "", status: 0 };
    };
    expect(resolveRepoRoot("/work/repo/sub", run)).toBe("/work/repo");
    expect(resolveRepoRoot("/other", run)).toBe("/work/repo"); // no memo — both shell out
    expect(seen).toEqual([
      ["git", "-C", "/work/repo/sub", "rev-parse", "--show-toplevel"],
      ["git", "-C", "/other", "rev-parse", "--show-toplevel"],
    ]);
  });

  test("propagates the runner's throw (not a repo)", () => {
    const run: CommandRunner = () => {
      throw new Error("not a git repository");
    };
    expect(() => resolveRepoRoot("/nope", run)).toThrow(/not a git repository/);
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
