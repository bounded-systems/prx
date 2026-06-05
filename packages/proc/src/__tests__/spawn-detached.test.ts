import { describe, expect, test } from "bun:test";

import { spawnDetached } from "../spawn-detached.ts";

describe("spawnDetached", () => {
  test("starts a process and returns a pid without blocking", () => {
    const { pid } = spawnDetached(["sleep", "0.2"]);
    expect(pid).toBeGreaterThan(0);
    try {
      process.kill(pid); // reap the detached child
    } catch {
      /* already gone */
    }
  });

  test("an empty command throws", () => {
    expect(() => spawnDetached([])).toThrow("empty command");
  });
});
