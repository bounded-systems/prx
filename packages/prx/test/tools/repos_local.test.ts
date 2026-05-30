import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  discoverLocalGitRepos,
  formatLocalReposResult,
  type LocalReposResult,
} from "../../src/tools/repos_local.ts";

function gitInit(dir: string, bare = false) {
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", ...(bare ? ["--bare"] : []), dir], { stdio: "ignore" });
}

describe("formatLocalReposResult", () => {
  const sample: LocalReposResult = {
    scanHome: "/scan",
    strict: false,
    repos: ["/scan/a", "/scan/b/.git"],
    count: 2,
  };

  test("plain lists repos one per line", () => {
    expect(formatLocalReposResult(sample, "plain", false)).toBe(
      "/scan/a\n/scan/b/.git",
    );
  });

  test("plain --count prints just the number", () => {
    expect(formatLocalReposResult(sample, "plain", true)).toBe("2");
  });

  test("json mirrors the structured result", () => {
    expect(JSON.parse(formatLocalReposResult(sample, "json", false))).toEqual(sample);
  });

  test("json --count emits only count", () => {
    expect(JSON.parse(formatLocalReposResult(sample, "json", true))).toEqual({ count: 2 });
  });
});

describe("discoverLocalGitRepos", () => {
  let scanHome: string;

  beforeAll(() => {
    scanHome = mkdtempSync(path.join(tmpdir(), "prx-repos-local-"));
    gitInit(path.join(scanHome, "alpha"));
    gitInit(path.join(scanHome, "nested", "beta"));
    // Pruned area in non-strict mode
    gitInit(path.join(scanHome, ".cache", "should-be-pruned"));
  });

  afterAll(() => {
    rmSync(scanHome, { recursive: true, force: true });
  });

  // Note: matches the bash original (find -name .git) — finds work trees
  // but not top-level bare repos (which have no `.git` entry).
  test("non-strict scan skips pruned dirs and finds work trees", async () => {
    const result = await discoverLocalGitRepos({ scanHome, strict: false });
    const names = result.repos.map((r) => r.replace(scanHome + "/", ""));
    expect(names).toContain("alpha");
    expect(names).toContain("nested/beta");
    expect(names.find((n) => n.includes(".cache"))).toBeUndefined();
    expect(result.count).toBe(result.repos.length);
  });

  test("strict scan includes the pruned-by-default tree", async () => {
    const result = await discoverLocalGitRepos({ scanHome, strict: true });
    const names = result.repos.map((r) => r.replace(scanHome + "/", ""));
    expect(names.some((n) => n.includes(".cache/should-be-pruned"))).toBe(true);
  });

  test("results are sorted and deduped", async () => {
    const result = await discoverLocalGitRepos({ scanHome, strict: false });
    const sorted = [...result.repos].sort();
    expect(result.repos).toEqual(sorted);
    expect(new Set(result.repos).size).toBe(result.repos.length);
  });
});
