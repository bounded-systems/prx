// runCaptured throws on a spawn error (ENOENT / undefined file), mirroring
// defaultRunner's error semantics. Covers the `if (result.error) throw` arm.

import { describe, expect, test } from "bun:test";

import { runCaptured } from "../index.ts";

describe("runCaptured", () => {
  test("rethrows a spawn error for a missing binary", () => {
    expect(() => runCaptured(["prx-definitely-not-a-real-binary-xyz"])).toThrow();
  });
});
