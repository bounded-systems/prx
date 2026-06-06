import { describe, expect, test } from "bun:test";

import { parseSourceFlag } from "../../src/pr-state/source-flag.ts";

// GH-1421 — `--source <name>` / `--source=<name>` parser. String parsing only;
// these cover both accepted forms, absence, and the malformed edge cases
// (dangling `--source`, empty `--source=`) that fall through to the remainder.

describe("parseSourceFlag", () => {
  test("absent flag yields no source and preserves argv order", () => {
    expect(parseSourceFlag(["session", "open", "GH-1"])).toEqual({
      remainder: ["session", "open", "GH-1"],
    });
  });

  test("two-token form captures the value and removes both tokens", () => {
    expect(parseSourceFlag(["plan", "--source", "gh", "GH-1"])).toEqual({
      source: "gh",
      remainder: ["plan", "GH-1"],
    });
  });

  test("equals form captures the value and removes the token", () => {
    expect(parseSourceFlag(["--source=notion", "open"])).toEqual({
      source: "notion",
      remainder: ["open"],
    });
  });

  test("dangling --source (no following token) falls through to remainder", () => {
    expect(parseSourceFlag(["open", "--source"])).toEqual({
      remainder: ["open", "--source"],
    });
  });

  test("--source followed by another flag does not consume the flag", () => {
    // The next token is a non-empty string, so the parser DOES treat it as the
    // value — documenting the string-only discipline (no flag-shape lookahead).
    expect(parseSourceFlag(["--source", "--verbose"])).toEqual({
      source: "--verbose",
      remainder: [],
    });
  });

  test("empty equals form (--source=) falls through to remainder", () => {
    expect(parseSourceFlag(["--source=", "open"])).toEqual({
      remainder: ["--source=", "open"],
    });
  });

  test("last --source occurrence wins when repeated", () => {
    expect(parseSourceFlag(["--source=a", "--source", "b"])).toEqual({
      source: "b",
      remainder: [],
    });
  });

  test("empty argv yields an empty remainder and no source", () => {
    expect(parseSourceFlag([])).toEqual({ remainder: [] });
  });
});
