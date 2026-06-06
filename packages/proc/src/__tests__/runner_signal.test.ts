// defaultRunner: a child terminated by a signal has a null exit status, which
// is mapped to 128 + signal-number. Covers the signalExitStatus path.

import { describe, expect, test } from "bun:test";

import { defaultRunner } from "../index.ts";

describe("defaultRunner signal handling", () => {
  test("a SIGTERM-killed child maps to status 143 (128 + 15)", () => {
    // `kill -TERM $$` makes the shell signal itself: spawnSync returns
    // status=null, signal="SIGTERM". check:false so the non-zero status is
    // returned rather than thrown.
    const r = defaultRunner(["sh", "-c", "kill -TERM $$"], { check: false });
    expect(r.status).toBe(143);
  });
});
