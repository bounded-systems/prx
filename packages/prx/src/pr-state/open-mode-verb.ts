// `prx open-mode` as a spec-driven VerbSpec — a contract-read slice of the
// cli.ts decomposition (ADR docs/prx/cli-decomposition.md), following
// graph/actors/model/skills. A pure read: it derives the open mode/state from
// the pr contract and renders it as the bare mode, JSON, or a `gh pr create`
// command. No side effects, no CliDeps.

import { z } from "zod";

import { defineVerb } from "../cli/verbspec.ts";
import { deriveInfo, loadContract } from "./contract.ts";
import { formatCreateCommand, formatReadyCommand } from "./cli-format.ts";

export const OpenModeOutput = z.object({ rendered: z.string() }).strict();
export type OpenModeOutput = z.infer<typeof OpenModeOutput>;

export const openModeVerb = defineVerb({
  id: "open-mode",
  summary: "Derive the pr open mode (draft/ready) from the contract; emit as mode, JSON, or a gh command.",
  actor: "work",
  input: z.object({
    contract: z.string().default(".pr/local/pr.json").describe("path to the pr contract"),
    format: z
      .enum(["mode", "json", "gh-create", "gh-ready"])
      .default("mode")
      .describe("output shape"),
    pr: z.string().optional().describe("PR ref; required with --format gh-ready"),
  }),
  output: OpenModeOutput,
  run: ({ contract, format, pr }): OpenModeOutput => {
    const info = deriveInfo(loadContract(contract));
    if (format === "mode") return { rendered: info.mode };
    if (format === "json") return { rendered: JSON.stringify(info, null, 2) };
    if (format === "gh-create") return { rendered: formatCreateCommand(info.mode) };
    if (!pr) throw new Error("--pr is required with --format gh-ready");
    return { rendered: formatReadyCommand(info.mode, info.state, pr) };
  },
  render: (out) => out.rendered,
});
