// GH-1661 — `parseRepoFlag` shared helper.

import { describe, expect, test } from "bun:test";

import { parseRepoFlag } from "../../src/pr-state/repo-flag.ts";

describe("parseRepoFlag", () => {
  test("no flag → undefined repo, argv passed through unchanged", () => {
    expect(parseRepoFlag(["GH-1", "--check"])).toEqual({
      remainder: ["GH-1", "--check"],
    });
  });

  test("--repo <value> two-token form", () => {
    expect(parseRepoFlag(["GH-1", "--repo", "ai-home"])).toEqual({
      repo: "ai-home",
      remainder: ["GH-1"],
    });
  });

  test("--repo=<value> equals form", () => {
    expect(parseRepoFlag(["GH-1", "--repo=ai-home"])).toEqual({
      repo: "ai-home",
      remainder: ["GH-1"],
    });
  });

  test("flag-then-positional order preserved in remainder", () => {
    expect(parseRepoFlag(["--repo", "ai-home", "GH-1"])).toEqual({
      repo: "ai-home",
      remainder: ["GH-1"],
    });
  });

  test("--repo with no value → flag left in remainder, no repo", () => {
    expect(parseRepoFlag(["GH-1", "--repo"])).toEqual({
      remainder: ["GH-1", "--repo"],
    });
  });

  test("--repo= (empty value) → flag left in remainder, no repo", () => {
    expect(parseRepoFlag(["GH-1", "--repo="])).toEqual({
      remainder: ["GH-1", "--repo="],
    });
  });

  test("last --repo wins when multiple are passed", () => {
    expect(parseRepoFlag(["--repo", "first", "--repo=second", "GH-1"])).toEqual({
      repo: "second",
      remainder: ["GH-1"],
    });
  });
});
