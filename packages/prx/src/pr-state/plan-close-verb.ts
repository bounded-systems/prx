// `prx plan close` as a spec-driven VerbSpec — a deps-bearing write migrated off
// cli.ts via the VerbSpec deps seam (ADR docs/prx/cli-decomposition.md), and the
// first consumer of the `exitCode` projection: a refusal (or a bd-record close
// that didn't land) is a *successful* run that still exits non-zero, exactly as
// the legacy handler returned 1. The GH issue close + bd reconcile live in the
// `planClose` driver (the plan-close-bd leaf); the verb owns parsing + framing.

import { z } from "zod";

import { defineVerb } from "../cli/verbspec.ts";
import { formatPlanCloseResult } from "./cli-format.ts";
import { planClose, type PlanCloseResult } from "./plan-close-bd.ts";
import { parseCanonicalWorkUnitId } from "../machine/work_unit.ts";

export type PlanCloseVerbDeps = { planClose: typeof planClose };
const realPlanCloseDeps = (): PlanCloseVerbDeps => ({ planClose });

// A loose projection of PlanCloseResult — the canonical shape is the TS type the
// driver returns; this is the multi-surface schema. `bdRecord` stays opaque.
export const PlanCloseOutput = z
  .object({
    workUnitId: z.string(),
    issueNumber: z.number().nullable(),
    reason: z.enum(["completed", "not-planned", "duplicate"]),
    upstream: z.string().nullable(),
    upstreamCommentPosted: z.boolean(),
    issueClosed: z.boolean(),
    bdRecord: z.unknown().nullable(),
    bdSyncExitCode: z.number().nullable(),
    handoff: z.array(z.string()),
    refusalReason: z.string().nullable(),
    dryRun: z.boolean(),
  })
  .loose();
export type PlanCloseOutput = z.infer<typeof PlanCloseOutput>;

export const planCloseVerb = defineVerb({
  id: "plan-close",
  summary: "Close a plan-mode work unit's GH issue without merging, and mirror the close into beads.",
  actor: "plan",
  positionals: ["workUnitId"],
  input: z.object({
    // Required positional — unlike `close` (which infers from branch), this
    // performs a real GH issue close, so operator intent must be explicit.
    workUnitId: z.string({
      error:
        "plan close requires an explicit work-unit id (e.g., `prx plan close GH-1050`); inference from the current branch is intentionally disabled to prevent accidental closes",
    }).describe("the work unit to close (e.g. GH-1050)"),
    reason: z
      .enum(["completed", "not-planned", "duplicate"], {
        error: "invalid --reason; expected one of: completed, not-planned, duplicate",
      })
      .default("completed")
      .describe("close reason"),
    upstream: z.string().optional().describe("upstream issue URL to point at on close"),
    "dry-run": z.coerce.boolean().default(false).describe("report what would happen without closing"),
    "no-next": z.coerce.boolean().default(false).describe("suppress the `prx delegate next` handoff hint"),
    format: z.enum(["plain", "json"]).default("plain").describe("output format"),
  }),
  output: PlanCloseOutput,
  deps: realPlanCloseDeps,
  run: async (input, deps: PlanCloseVerbDeps = realPlanCloseDeps()): Promise<PlanCloseOutput> => {
    const workUnitId = parseCanonicalWorkUnitId(input.workUnitId);
    if (!workUnitId) {
      throw new Error(`plan close: not a canonical work-unit id: ${input.workUnitId}`);
    }
    const result = await deps.planClose({
      workUnitId,
      reason: input.reason,
      upstream: input.upstream ?? null,
      dryRun: input["dry-run"],
      emitNext: !input["no-next"],
    });
    return result;
  },
  render: (out, input) => formatPlanCloseResult(out as PlanCloseResult, input.format),
  // A refusal, or a bd-record close that didn't land, exits 1 even though the
  // run itself succeeded — shell hooks must see the failure (legacy parity).
  exitCode: (out) => {
    if (out.refusalReason) return 1;
    const bd = out.bdRecord as { ok?: boolean } | null;
    if (bd && bd.ok === false) return 1;
    return 0;
  },
});
