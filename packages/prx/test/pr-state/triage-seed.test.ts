/**
 * prx-383 — `prx triage agent <id>` seeds triage at one work-unit (the
 * reference-seed mirror of intake's `--message`). No id ⇒ the whole-queue sweep.
 */
import { describe, expect, test } from "bun:test";

import {
  buildOpsTriageSdkRuntimeProfile,
  triageUserPrompt,
} from "../../src/machine/runtime_profiles.ts";

describe("triageUserPrompt (prx-383)", () => {
  test("with a work-unit id: triage THAT item", () => {
    const p = triageUserPrompt("prx-0v5");
    expect(p).toContain("prx-0v5");
    expect(p.toLowerCase()).toContain("triage the specific work-unit");
  });

  test("without an id: the whole-queue sweep", () => {
    expect(triageUserPrompt().toLowerCase()).toContain("run the triage pass");
    expect(triageUserPrompt()).not.toContain("specific work-unit");
  });

  test("blank id falls back to the sweep", () => {
    expect(triageUserPrompt("  ")).toBe(triageUserPrompt());
  });
});

describe("buildOpsTriageSdkRuntimeProfile seed (prx-383)", () => {
  test("the id reaches the headless SDK profile's prompt", () => {
    const seeded = buildOpsTriageSdkRuntimeProfile("prx-0v5");
    expect(seeded.sdkSpec?.prompt).toContain("prx-0v5");
    expect(seeded.interaction).toBe("headless");
  });

  test("no id ⇒ the default sweep profile (unchanged)", () => {
    expect(buildOpsTriageSdkRuntimeProfile().sdkSpec?.prompt).not.toContain(
      "specific work-unit",
    );
  });
});
