/**
 * prx-28w — `prx intake agent --message "…"` seeds the intake operator at one
 * specific item (dedupe → file/merge) instead of a whole-queue sweep.
 */
import { describe, expect, test } from "bun:test";

import {
  buildOpsIntakeSdkRuntimeProfile,
  intakeUserPrompt,
} from "../../src/machine/runtime_profiles.ts";

describe("intakeUserPrompt (prx-28w)", () => {
  test("with a message: aims at THAT item, dedupe-first, typed file", () => {
    const p = intakeUserPrompt("the readme is out of date");
    expect(p).toContain("the readme is out of date");
    expect(p.toLowerCase()).toContain("dedupe-search");
    expect(p).toContain("bug | task | feature | spike | decision");
  });

  test("without a message: the whole-queue sweep prompt", () => {
    const p = intakeUserPrompt();
    expect(p.toLowerCase()).toContain("search the queue");
    expect(p).not.toContain("operator reports");
  });

  test("blank/whitespace message falls back to the sweep prompt", () => {
    expect(intakeUserPrompt("   ")).toBe(intakeUserPrompt());
  });
});

describe("buildOpsIntakeSdkRuntimeProfile seed (prx-28w)", () => {
  test("the message reaches the headless SDK profile's prompt", () => {
    const seeded = buildOpsIntakeSdkRuntimeProfile("the readme is out of date");
    expect(seeded.sdkSpec?.prompt).toContain("the readme is out of date");
    // still headless intake, allowlist intact
    expect(seeded.interaction).toBe("headless");
    expect(seeded.sdkSpec?.allowedTools).toContain("Bash(prx intake:*)");
  });

  test("no message ⇒ the default sweep profile (unchanged behavior)", () => {
    const swept = buildOpsIntakeSdkRuntimeProfile();
    expect(swept.sdkSpec?.prompt).not.toContain("operator reports");
    expect(swept.sdkSpec?.prompt?.toLowerCase()).toContain("search the queue");
  });
});
