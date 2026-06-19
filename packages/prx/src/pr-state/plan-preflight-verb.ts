// `prx plan preflight` (a.k.a. `plan preflight`) as a deps-bearing VerbSpec
// migrated off cli.ts (ADR docs/prx/cli-decomposition.md). A deterministic
// pre-draft check (already-done / infeasible-action / blocked-by-open-deps).
// Exit 0 on pass, 1 on a refusal (the check ran and said no), 2 when the check
// itself could not run (network/parse) — the last via CliExitError so operators
// can distinguish the two.

import { z } from "zod";

import { CliExitError, defineVerb } from "@bounded-systems/verbspec";
import { CliError } from "./cli-error.ts";
import { parseCanonicalWorkUnitId } from "./cli-id.ts";
import { formatPreflightPlain, runPlanPreflight } from "../plan/preflight.ts";
import { preflightExitCode, type PreflightResult } from "../plan/preflight_schema.ts";

export type PlanPreflightDeps = { runPlanPreflight: typeof runPlanPreflight };
const realPlanPreflightDeps = (): PlanPreflightDeps => ({ runPlanPreflight });

type PlanPreflightOutput = { result: PreflightResult };

export const planPreflightVerb = defineVerb({
  id: "plan-preflight",
  summary:
    "Deterministic pre-draft preflight (already-done / infeasible-action / blocked-by-open-deps).",
  actor: "plan",
  positionals: ["unit"],
  input: z.object({
    unit: z.string().optional().describe("work unit to check (required positional)"),
    format: z.enum(["plain", "json"]).default("plain").describe("output format"),
  }),
  output: z.object({ result: z.unknown() }).loose(),
  deps: realPlanPreflightDeps,
  run: async (
    input,
    deps: PlanPreflightDeps = realPlanPreflightDeps(),
  ): Promise<PlanPreflightOutput> => {
    if (!input.unit) {
      throw new CliError(
        "plan preflight requires a work-unit id (e.g., `prx plan preflight GH-1239`)",
      );
    }
    const unit = parseCanonicalWorkUnitId(input.unit, "plan preflight");
    try {
      return { result: await deps.runPlanPreflight({ unit }) };
    } catch (error) {
      // The check could not run (network/parse) → exit 2, distinct from a
      // refusal (exit 1). No stdout.
      const message = error instanceof Error ? error.message : String(error);
      throw new CliExitError(`plan preflight: ${message}`, 2);
    }
  },
  exitCode: (out) => preflightExitCode((out as PlanPreflightOutput).result.status),
  render: (out, input) => {
    const r = (out as PlanPreflightOutput).result;
    return input.format === "json" ? JSON.stringify(r, null, 2) : formatPreflightPlain(r);
  },
});
