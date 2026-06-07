import { describe, expect, test } from "bun:test";

import { statelyVerb, type StatelyDeps, type StatelyOutput } from "../../src/pr-state/stately-verb.ts";

// `prx stately` (a.k.a. `model stately`) is the first deps-bearing VerbSpec
// (ADR docs/prx/cli-decomposition.md). These exercise the VerbSpec deps seam:
// a test passes its own StatelyDeps slice straight to `run` — the same
// injection the legacy cli.ts CliDeps bag provided, now scoped to the verb.

function captureDeps(): { deps: StatelyDeps; copied: () => string; opened: () => string; prompted: () => boolean } {
  let copied = "";
  let opened = "";
  let prompted = false;
  return {
    deps: {
      copyToClipboard: (text) => {
        copied = text;
      },
      openAfterEnter: (url) => {
        prompted = true;
        opened = url;
      },
      open: (url) => {
        opened = url;
      },
    },
    copied: () => copied,
    opened: () => opened,
    prompted: () => prompted,
  };
}

const baseInput = {
  url: "https://stately.ai/registry/editor/",
  "no-wait": false,
  model: "lifecycle" as const,
};

describe("stately verb", () => {
  test("copies the xstate-ts machine and opens the url after the prompt", () => {
    const cap = captureDeps();
    const out = statelyVerb.run(baseInput, cap.deps) as StatelyOutput;

    expect(cap.copied()).toContain('import { createMachine } from "xstate";');
    expect(cap.prompted()).toBe(true);
    expect(cap.opened()).toBe("https://stately.ai/registry/editor/");
    expect(out.message).toBe(
      "Copied machine to clipboard and opened https://stately.ai/registry/editor/",
    );
  });

  test("--no-wait opens without the Enter prompt", () => {
    const cap = captureDeps();
    statelyVerb.run({ ...baseInput, "no-wait": true }, cap.deps);

    expect(cap.prompted()).toBe(false);
    expect(cap.opened()).toBe("https://stately.ai/registry/editor/");
  });

  test("the copied machine carries the full xstate-ts (system machine + guards)", () => {
    const cap = captureDeps();
    statelyVerb.run({ ...baseInput, model: "system" }, cap.deps);

    expect(cap.copied()).toContain('"id": "prSystem"');
    expect(cap.copied()).toContain("isMergeable");
  });

  test("render returns the confirmation message", () => {
    const out: StatelyOutput = { message: "Copied machine to clipboard and opened X" };
    expect(statelyVerb.render!(out, baseInput)).toBe(out.message);
  });

  test("declares a default deps slice (the reals the CLI runs with)", () => {
    expect(typeof statelyVerb.deps).toBe("function");
    const real = statelyVerb.deps!();
    expect(typeof real.copyToClipboard).toBe("function");
    expect(typeof real.openAfterEnter).toBe("function");
    expect(typeof real.open).toBe("function");
  });
});
