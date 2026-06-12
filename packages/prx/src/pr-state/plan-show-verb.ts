// `prx plan show` (a.k.a. `plan show`) as a deps-bearing VerbSpec migrated off
// cli.ts (ADR docs/prx/cli-decomposition.md). Two modes: `--paths` reports where
// plans land (CAS root + staging dir) without reading a blob; otherwise it reads
// the slot and prints a head preview (or full body as json). All stdout.

import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import { CliError } from "./cli-error.ts";
import { detectWorkCommandTarget, parseCanonicalWorkUnitId } from "./cli-id.ts";
import {
  PlanStoreError,
  resolvePlanStagingDirForDisplay,
  resolveStoreRootForDisplay,
} from "../plan-store/cas.ts";
import { resolvePlanSessionUnit } from "../plan-store/session-context.ts";
import { PlanRefNotFound, runPlanShow, type RunPlanShowResult } from "../plan-store/verbs.ts";

export type PlanShowDeps = { runPlanShow: typeof runPlanShow };
const realPlanShowDeps = (): PlanShowDeps => ({ runPlanShow });

type PlanShowOutput =
  | {
      mode: "paths";
      unit: string;
      casRoot: string;
      source: string;
      staging: string | null;
      stagingSource: string | null;
    }
  | { mode: "show"; result: RunPlanShowResult };

const PlanShowOutputSchema = z.object({ mode: z.enum(["paths", "show"]) }).loose();

export const planShowVerb = defineVerb({
  id: "plan-show",
  summary: "Show a plan slot (head preview or full json), or --paths to report where plans land.",
  actor: "plan",
  positionals: ["unit"],
  input: z.object({
    unit: z.string().optional().describe("work unit (positional or --unit; or an open planner pane)"),
    slot: z.enum(["draft", "approved"]).optional().describe("plan slot (defaults to the store's default)"),
    format: z.enum(["text", "json"]).default("text").describe("output format"),
    paths: z.coerce.boolean().default(false).describe("report CAS root + staging dir without reading a blob"),
  }),
  output: PlanShowOutputSchema,
  deps: realPlanShowDeps,
  run: async (input, deps: PlanShowDeps = realPlanShowDeps()): Promise<PlanShowOutput> => {
    const resolved = resolvePlanSessionUnit(input.unit, { detect: detectWorkCommandTarget });
    if (resolved.unit === null) {
      throw new CliError(
        "plan show requires a work-unit id (positional or --unit), or run from an open `prx plan session` pane",
      );
    }
    const unit =
      resolved.source === "flag" ? parseCanonicalWorkUnitId(resolved.unit, "plan show") : resolved.unit;

    if (input.paths) {
      const resolution = resolveStoreRootForDisplay("plans");
      let staging: string | null = null;
      let stagingSource: string | null = null;
      try {
        const s = resolvePlanStagingDirForDisplay();
        staging = s.dir;
        stagingSource = s.source;
      } catch (error) {
        // Only swallow the documented env-underpopulated case.
        if (!(error instanceof PlanStoreError) || error.code !== "NO_STAGING_ROOT") throw error;
      }
      return { mode: "paths", unit, casRoot: resolution.root, source: resolution.source, staging, stagingSource };
    }

    try {
      return { mode: "show", result: await deps.runPlanShow({ unit, slot: input.slot }) };
    } catch (error) {
      if (error instanceof PlanRefNotFound) throw new Error(`FAIL: ${error.message}`);
      throw error;
    }
  },
  render: (out, input) => {
    const o = out as PlanShowOutput;
    const json = input.format === "json";
    if (o.mode === "paths") {
      if (json) {
        return JSON.stringify(
          { unit: o.unit, domain: "plans", cas_root: o.casRoot, source: o.source, staging: o.staging, staging_source: o.stagingSource },
          null,
          2,
        );
      }
      return [
        `unit:           ${o.unit}`,
        `domain:         plans`,
        `cas_root:       ${o.casRoot}`,
        `source:         ${o.source}`,
        `staging:        ${o.staging ?? "(unresolved — set XDG_CACHE_HOME or HOME)"}`,
        `staging_source: ${o.stagingSource ?? "(none)"}`,
      ].join("\n");
    }
    const r = o.result;
    if (json) {
      return JSON.stringify(
        { unit: r.unit, slot: r.slot, sha: r.sha, size: r.size, body: r.body.toString("utf8") },
        null,
        2,
      );
    }
    const lines = r.body.toString("utf8").split("\n");
    const head = lines.slice(0, 20);
    const out2 = [`unit: ${r.unit}`, `slot: ${r.slot}`, `sha:  ${r.sha}`, `size: ${r.size} bytes`, "---", ...head];
    if (lines.length > 20) {
      out2.push(`... (${lines.length - 20} more lines; use --format json for full body)`);
    }
    return out2.join("\n");
  },
});
