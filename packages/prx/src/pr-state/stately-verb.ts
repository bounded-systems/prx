// `prx stately` (a.k.a. `model stately`) as a spec-driven VerbSpec — the first
// deps-bearing handler migrated off cli.ts (ADR docs/prx/cli-decomposition.md),
// proving the VerbSpec deps seam that replaces the cli.ts `CliDeps` bag. The
// command copies the xstate-ts machine to the clipboard and opens the Stately
// editor; those side effects are the verb's small `StatelyDeps` slice, defaulted
// to the real proc-backed implementations and overridable in tests.

import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import { formatGraph } from "./cli-format.ts";
import { copyToClipboard, openAfterEnter, runInheritStatus } from "./cli-spawn.ts";

export type StatelyDeps = {
  copyToClipboard: (text: string) => void;
  openAfterEnter: (url: string) => void;
  /** Open a URL without the interactive Enter prompt (the `--no-wait` path). */
  open: (url: string) => void;
};

const realStatelyDeps = (): StatelyDeps => ({
  copyToClipboard,
  openAfterEnter,
  open: (url) => {
    if (runInheritStatus(["/usr/bin/open", url]) !== 0) {
      throw new Error(`Failed to open ${url}`);
    }
  },
});

export const StatelyOutput = z.object({ message: z.string() }).strict();
export type StatelyOutput = z.infer<typeof StatelyOutput>;

export const statelyVerb = defineVerb({
  id: "stately",
  summary: "Copy the prx machine (xstate-ts) to the clipboard and open it in the Stately editor.",
  actor: "work",
  input: z.object({
    url: z.string().default("https://stately.ai/registry/editor/").describe("Stately editor URL"),
    "no-wait": z.coerce.boolean().default(false).describe("skip the Enter prompt and open immediately"),
    // Parsed for back-compat with the legacy command; the emitted machine is
    // always xstate-ts (matching the prior handler, which ignored --model).
    model: z.enum(["lifecycle", "system"]).default("lifecycle").describe("(reserved)"),
  }),
  output: StatelyOutput,
  deps: realStatelyDeps,
  run: (input, deps: StatelyDeps = realStatelyDeps()): StatelyOutput => {
    deps.copyToClipboard(formatGraph("xstate-ts"));
    if (input["no-wait"]) {
      deps.open(input.url);
    } else {
      deps.openAfterEnter(input.url);
    }
    return { message: `Copied machine to clipboard and opened ${input.url}` };
  },
  render: (out) => out.message,
});
