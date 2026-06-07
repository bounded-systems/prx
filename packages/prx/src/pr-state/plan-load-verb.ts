// `prx plan load` (a.k.a. `plan load`) as a deps-bearing VerbSpec migrated off
// cli.ts (ADR docs/prx/cli-decomposition.md). Reads a plan slot and writes the
// raw body to stdout (exact bytes, no trailing newline — via the `Buffer`
// render + the bridge's writeRaw), or a JSON envelope. Without an explicit
// `--slot` it falls back approved→draft, noting the fallback on stderr (the
// `warnings` projection). `PlanRefNotFound` → `FAIL: …` (stderr, exit 1).

import { z } from "zod";

import { defineVerb } from "../cli/verbspec.ts";
import { CliError } from "./cli-error.ts";
import { detectWorkCommandTarget, parseCanonicalWorkUnitId } from "./cli-id.ts";
import { resolvePlanSessionUnit } from "../plan-store/session-context.ts";
import { PlanRefNotFound, runPlanLoad, type RunPlanLoadResult } from "../plan-store/verbs.ts";

export type PlanLoadDeps = { runPlanLoad: typeof runPlanLoad };
const realPlanLoadDeps = (): PlanLoadDeps => ({ runPlanLoad });

type PlanLoadOutput = { unit: string; result: RunPlanLoadResult };

const PlanLoadOutputSchema = z.object({ unit: z.string() }).loose();

export const planLoadVerb = defineVerb({
  id: "plan-load",
  summary: "Load a plan slot to stdout (raw body or json); falls back approved→draft when --slot is omitted.",
  actor: "plan",
  positionals: ["unit"],
  input: z.object({
    unit: z.string().optional().describe("work unit (positional or --unit; or an open planner pane)"),
    slot: z.enum(["draft", "approved"]).optional().describe("plan slot (omit to fall back approved→draft)"),
    format: z.enum(["raw", "json"]).default("raw").describe("output format"),
  }),
  output: PlanLoadOutputSchema,
  deps: realPlanLoadDeps,
  run: async (input, deps: PlanLoadDeps = realPlanLoadDeps()): Promise<PlanLoadOutput> => {
    const resolved = resolvePlanSessionUnit(input.unit, { detect: detectWorkCommandTarget });
    if (resolved.unit === null) {
      throw new CliError(
        "plan load requires a work-unit id (positional or --unit), or run from an open `prx plan session` pane",
      );
    }
    const unit =
      resolved.source === "flag" ? parseCanonicalWorkUnitId(resolved.unit, "plan load") : resolved.unit;
    try {
      const result = await deps.runPlanLoad({
        unit,
        slot: input.slot ?? "approved",
        fallbackToDraft: input.slot === undefined,
      });
      return { unit, result };
    } catch (error) {
      if (error instanceof PlanRefNotFound) throw new Error(`FAIL: ${error.message}`);
      throw error;
    }
  },
  // Stderr note when an omitted --slot fell back approved→draft.
  warnings: (out) => {
    const o = out as PlanLoadOutput;
    return o.result.fellBackToDraft
      ? [`note: no approved plan for ${o.unit}, falling back to draft (sha=${o.result.sha})`]
      : [];
  },
  // Raw format ⇒ exact bytes (no trailing newline) via the bridge's writeRaw.
  renderRaw: (out, input) => (input.format === "raw" ? (out as PlanLoadOutput).result.content : null),
  render: (out) => {
    const o = out as PlanLoadOutput;
    // Only reached for --format=json (renderRaw handles raw).
    return JSON.stringify(
      { unit: o.unit, slot: o.result.slot, sha: o.result.sha, size: o.result.content.length, body: o.result.content.toString("utf8") },
      null,
      2,
    );
  },
});
