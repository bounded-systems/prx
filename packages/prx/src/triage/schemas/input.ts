// Verb input (option) schemas — boundary layer for `prx triage <verb>`.
//
// Existing-verb schemas (status, classify, apply, prioritize, promote) live in
// their respective verb files and are re-exported here so all triage-verb IO
// is grep-able from one place. The current CLI dispatch in
// src/pr-state/cli.ts continues to import from the original locations.
//
// Forward-declared schemas (type-pass, prioritize-bulk, drift-fix, report)
// carry typed inputs for verbs not yet implemented; their actor slots
// throw until the sibling tickets fill them. Schemas land here now so
// those PRs land into typed inputs slot-for-slot.

import { z } from "zod";

import { triageStatusOptionsSchema, type TriageStatusOptions } from "../triage.ts";
import { triageClassifyOptionsSchema, type TriageClassifyOptions } from "../classifier.ts";
import { triageApplyOptionsSchema, type TriageApplyOptions } from "../apply.ts";
import { triagePrioritizeOptionsSchema, type TriagePrioritizeOptions } from "../prioritize.ts";
import { triagePromoteOptionsSchema, type TriagePromoteOptions } from "../promote.ts";
// GH-1342: drift-fix is no longer a forward-declaration — the verb landed in
// drift-fix.ts with a broader option shape (`apply`, `from`, `sync` in
// addition to the original `repo`/`axes`/`limit`/`dryRun`). Re-export the
// canonical schema so machine/actor consumers see the same type the verb's
// runtime parses against. Mirrors the prioritize-bulk / type-pass pattern.
import {
  triageDriftFixOptionsSchema as triageDriftFixVerbOptionsSchema,
  type TriageDriftFixOptions as TriageDriftFixVerbOptions,
} from "../drift-fix.ts";

export {
  triageStatusOptionsSchema,
  triageClassifyOptionsSchema,
  triageApplyOptionsSchema,
  triagePrioritizeOptionsSchema,
  triagePromoteOptionsSchema,
};

export type {
  TriageStatusOptions,
  TriageClassifyOptions,
  TriageApplyOptions,
  TriagePrioritizeOptions,
  TriagePromoteOptions,
};

// GH-1021 — type-pass (Haiku batch type classifier).
export const triageTypePassOptionsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).default("claude-haiku-4-5-20251001"),
  batchSize: z.number().int().positive().default(30),
  limit: z.number().int().min(0).default(0),
  dryRun: z.boolean().default(false),
});
export type TriageTypePassOptions = z.infer<typeof triageTypePassOptionsSchema>;

// GH-1047 — prioritize-bulk (Haiku batch priority classifier).
export const triagePrioritizeBulkOptionsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).default("claude-haiku-4-5-20251001"),
  batchSize: z.number().int().positive().default(30),
  limit: z.number().int().min(0).default(0),
  dryRun: z.boolean().default(false),
});
export type TriagePrioritizeBulkOptions = z.infer<typeof triagePrioritizeBulkOptionsSchema>;

// GH-1049 — drift-fix (reconcile bd↔GH type/priority drift, GH-authoritative).
// Canonical schema lives in `../drift-fix.ts`; re-exported here so the barrel
// stays the single import surface for triage Zod boundaries.
export const triageDriftFixOptionsSchema = triageDriftFixVerbOptionsSchema;
export type TriageDriftFixOptions = TriageDriftFixVerbOptions;

// GH-1022 — report (session totals + cost summary from JSONL audit logs).
export const triageReportOptionsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  since: z.string().trim().min(1).optional(),
  format: z.enum(["pretty", "json"]).default("pretty"),
  includeFilings: z.boolean().default(false),
});
export type TriageReportOptions = z.infer<typeof triageReportOptionsSchema>;

// GH-1015 — `prx triage prime`: orchestrator verb that drives the untriaged
// count toward 0 by looping the classify → apply → (priority) → promote chain
// until the queue stabilizes. Wraps the `triageMachine` with `scope: "prime"`
// so the orphan / drift / report tail is out of scope per the issue body.
export const triagePrimeOptionsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  dryRun: z.boolean().default(false),
  autoPrioritize: z.boolean().default(false),
  // GH-1342 — chain the drift reconcile actor into each prime iteration so a
  // single `prx triage prime` invocation can both drain untriaged AND
  // reconcile bd↔GH drift in one verb. Default false keeps existing callers
  // on the GH-1015 short-circuit path (promoting → done).
  autoDriftFix: z.boolean().default(false),
  maxIterations: z.number().int().positive().default(5),
  format: z.enum(["plain", "json"]).default("plain"),
});
export type TriagePrimeOptions = z.infer<typeof triagePrimeOptionsSchema>;

// GH-1125 — `prx prune --merged-only` pre-step in `triage prime`. Closes
// GH issues whose linked PR has merged but whose issue state is still open
// (and tears the matching worktrees down once GH-1126 lands). The state runs
// at the head of the triage machine for both `prime` and `full` scopes; no
// scope guard applies because the sweep is unconditionally beneficial.
export const triagePruneMergedOptionsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  dryRun: z.boolean().default(false),
});
export type TriagePruneMergedOptions = z.infer<typeof triagePruneMergedOptionsSchema>;
