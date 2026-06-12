// `prx status` as a spec-driven VerbSpec — migrated off cli.ts (ADR
// docs/prx/cli-decomposition.md) once printStatus/refreshTaskSignals moved to
// the status-report leaf. A read over the contract: it renders the derived
// status (bare mode / JSON / human line), and for the plain line also refreshes
// the default task contract's signals (the leaf owns that side effect). The
// missing-contract ENOENT is mapped to the friendly hint by runSpecVerb.

import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import { renderStatus } from "./status-report.ts";

export const StatusOutput = z.object({ rendered: z.string() }).strict();
export type StatusOutput = z.infer<typeof StatusOutput>;

export const statusVerb = defineVerb({
  id: "status",
  summary: "Show the PR contract's derived status (state/mode/reason) as a line, bare mode, or JSON.",
  actor: "work",
  input: z.object({
    contract: z.string().default(".pr/local/pr.json").describe("path to the pr contract"),
    format: z.enum(["plain", "mode", "json"]).default("plain").describe("output format"),
  }),
  output: StatusOutput,
  run: ({ contract, format }): StatusOutput => ({ rendered: renderStatus(contract, format) }),
  render: (out) => out.rendered,
});
